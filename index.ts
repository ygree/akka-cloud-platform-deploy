// Copyright 2016-2019, Pulumi Corporation.  All rights reserved.

import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";

let config = new pulumi.Config();
// install metrics-server by default if no config exists
var installMetricsServer = config.getBoolean("install-metrics-server");
if (installMetricsServer == undefined) {
	installMetricsServer = true;
}


// K8s namespace for operator
const namespaceName = "lightbend";

/**
 * Per NodeGroup IAM: each NodeGroup will bring its own, specific instance role and profile.
 */
const managedPolicyArns: string[] = [
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
];

const namePrefix = `${pulumi.getProject()}-${pulumi.getStack()}`;

export function name(suffix: string): string {
	return `${namePrefix}-${suffix}`;
}


// Creates a role and attaches the EKS worker node IAM managed policies. Used a few times below,
// to create multiple roles, so we use a function to avoid repeating ourselves.
export function createNodeGroupRole(name: string): aws.iam.Role {
    const role = new aws.iam.Role(name, {
        assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
            Service: "ec2.amazonaws.com",
        }),
    });

    let counter = 0;
    for (const policy of managedPolicyArns) {
        // Create RolePolicyAttachment without returning it.
        const rpa = new aws.iam.RolePolicyAttachment(`${name}-policy-${counter++}`,
            { policyArn: policy, role: role },
        );
    }

    return role;
}

// Now create the roles and instance profiles for the two worker groups.
const fixedWorkersRole = createNodeGroupRole(name("fixed-workers-role"));
//const spotWorkersRole = createNodeGroupRole("spot-workers-role");
const fixedWorkersInstanceProfile = new aws.iam.InstanceProfile(name("fixed-workers-instance-profile"), {role: fixedWorkersRole});
//const spotWorkersInstanceProfile = new aws.iam.InstanceProfile("spot-workers-instance-profile", {role: spotWorkers});


// Create a VPC for our cluster.
const vpc = new awsx.ec2.Vpc(name("vpc"), { numberOfAvailabilityZones: 2 });

// Create the EKS cluster itself and a deployment of the Kubernetes dashboard.
const cluster = new eks.Cluster(name("eks"), {
    skipDefaultNodeGroup: true,
    createOidcProvider: true,
    instanceRoles: [ fixedWorkersRole ],
    vpcId: vpc.id,
    subnetIds: vpc.publicSubnetIds,
    // fixme: use configuration
    version: "1.17",
});

const fixedNodeGroup = cluster.createNodeGroup(name("fixed-workers-node-group"), {
    // fixme: use configuration
    desiredCapacity: 3,
    minSize: 1,
    maxSize: 4,
    labels: {"ondemand": "true"},
    instanceProfile: fixedWorkersInstanceProfile,
});

// Now create a preemptible node group, using spot pricing, for our variable, ephemeral workloads.
// const spotNodeGroup = new eks.NodeGroup("my-cluster-ng2", {
//     cluster: cluster,
//     instanceType: "t2.medium",
//     desiredCapacity: 1,
//     spotPrice: "1",
//     minSize: 1,
//     maxSize: 2,
//     labels: {"preemptible": "true"},
//     taints: {
//         "special": {
//             value: "true",
//             effect: "NoSchedule",
//         },
//     },
//     instanceProfile: instanceProfile2,
// }, {
//     providers: { kubernetes: cluster.provider},
// });

// Install k8s metrics-server
if (installMetricsServer) {
	const metricsServer = new k8s.yaml.ConfigGroup("metrics-server",
	    { files: "https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml" },
	    { provider: cluster.provider },
	);
}

// Create service account with MeterUsage IAM policy

// Create a k8s namespace in the cluster.
const namespace = new k8s.core.v1.Namespace(namespaceName, {
	metadata: {
		name: namespaceName // otherwise pulumi will append a random suffix to the namespace.. might be useful for integration testing to do that
	}
});

const saName = pulumi.getProject();

// Export the cluster OIDC provider URL.
if (!cluster?.core?.oidcProvider) {
    throw new Error("Invalid cluster OIDC provider URL");
}
const clusterOidcProvider = cluster.core.oidcProvider;
export const clusterOidcProviderUrl = clusterOidcProvider.url;

export const operatorNamespace = namespace.metadata.name;

const saAssumeRolePolicy = pulumi
	.all([clusterOidcProviderUrl, clusterOidcProvider.arn, namespace.metadata])
	.apply(([url, arn, ns]) => aws.iam.getPolicyDocument({
	    statements: [{
	        actions: ["sts:AssumeRoleWithWebIdentity"],
	        conditions: [{
	            test: "StringEquals",
	            values: [`system:serviceaccount:${ns.name}:${saName}`],
	            variable: `${url.replace("https://", "")}:sub`,
	        }],
	        effect: "Allow",
	        principals: [{
	            identifiers: [arn],
	            type: "Federated",
	        }],
	    }],
	})
);

const saRole = new aws.iam.Role(saName, {
  assumeRolePolicy: saAssumeRolePolicy.json,
});

const meterUsagePolicy = new aws.iam.Policy(name("meter-usage-role-policy"), {
    policy: JSON.stringify({
	    "Version": "2012-10-17",
	    "Statement": [
	        {
	            "Effect": "Allow",
	            "Action": [
	                "aws-marketplace:MeterUsage"
	            ],
	            "Resource": "*"
	        }
	    ]
	})
});

// Attach the IAM role to the MeterUsage policy
const saMeterUsageRpa = new aws.iam.RolePolicyAttachment(saName, {
  policyArn: meterUsagePolicy.arn,
  role: saRole,
});


// Create a Service Account with the IAM role annotated to use with the Pod.
const sa = new k8s.core.v1.ServiceAccount(
  saName,
  {
    metadata: {
      namespace: namespace.metadata.name,
      name: saName,
      annotations: {
        'eks.amazonaws.com/role-arn': saRole.arn
      },
    },
  });

// Export the cluster's kubeconfig.
export const kubeconfig = cluster.kubeconfig;
// EKS cluster name
export const clusterId = cluster.eksCluster.id;
