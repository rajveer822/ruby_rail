import { execSync } from 'child_process';
import Docker from 'dockerode';
import * as k8s from '@kubernetes/client-node';
import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';




// Initialize clients
const docker = new Docker();
const kc = new k8s.KubeConfig();
kc.loadFromDefault(); // Assumes kubeconfig is set up
const k8sApi = kc.makeApiClient(k8s.AppsV1Api);

// Environment variables (set in CI/CD tool)
const DOCKER_REGISTRY = process.env.DOCKER_REGISTRY || 'your-registry.com';
const DOCKER_USERNAME = process.env.DOCKER_USERNAME;
const DOCKER_PASSWORD = process.env.DOCKER_PASSWORD;
const IMAGE_NAME = 'legal-app';
const K8S_NAMESPACE = process.env.K8S_NAMESPACE || 'default';
const K8S_DEPLOYMENT_NAME = 'legal-app-deployment';

// Function to run Rails unit tests
async function runUnitTests() {
  console.log('Running Rails unit tests...');
  try {
    // Assume Rails app is in current directory; run tests
    execSync('bundle exec rails test', { stdio: 'inherit', cwd: process.cwd() });
    console.log('✅ Unit tests passed.');
  } catch (error) {
    console.error('❌ Unit tests failed:', error.message);
    process.exit(1);
  }
}

// Function to build and push Docker image
async function buildDockerImage() {
  console.log('Building Docker image...');
  const git = simpleGit();
  const branch = (await git.branch()).current;
  const commit = (await git.log({ n: 1 })).latest.hash;
  const tag = branch === 'production' ? `prod-${commit}` : `dev-${commit}`;
  const fullImageName = `${DOCKER_REGISTRY}/${IMAGE_NAME}:${tag}`;

  try {
    // Build image (assume Dockerfile in Rails app root)
    const stream = await docker.buildImage({
      context: process.cwd(),
      src: ['Dockerfile', 'Gemfile', 'Gemfile.lock', 'app/', 'config/', 'db/', 'lib/'] // Rails-specific files
    }, { t: fullImageName });
    await new Promise((resolve, reject) => {
      docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
    });

    // Push image
    console.log('Pushing Docker image...');
    const image = docker.getImage(fullImageName);
    await image.push({
      authconfig: {
        username: DOCKER_USERNAME,
        password: DOCKER_PASSWORD,
        serveraddress: DOCKER_REGISTRY
      }
    });
    console.log(`✅ Docker image pushed: ${fullImageName}`);
    return fullImageName;
  } catch (error) {
    console.error('❌ Docker build/push failed:', error.message);
    process.exit(1);
  }
}

// Function to deploy to Kubernetes
async function deployToK8s(imageName) {
  console.log('Deploying to Kubernetes...');
  try {
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: K8S_DEPLOYMENT_NAME, namespace: K8S_NAMESPACE },
      spec: {
        replicas: 3, // Enterprise-scale replicas
        selector: { matchLabels: { app: 'legal-app' } },
        template: {
          metadata: { labels: { app: 'legal-app' } },
          spec: {
            containers: [{
              name: 'legal-app',
              image: imageName,
              ports: [{ containerPort: 3000 }], // Rails default port
              env: [
                { name: 'RAILS_ENV', value: 'production' },
                // Add other env vars as needed (e.g., DB secrets from K8s secrets)
              ]
            }]
          }
        }
      }
    };

    // Apply deployment
    await k8sApi.createNamespacedDeployment(K8S_NAMESPACE, deployment);
    console.log('✅ Deployment created/updated in K8s.');
  } catch (error) {
    console.error('❌ K8s deployment failed:', error.message);
    process.exit(1);
  }
}

// Main pipeline logic
async function main(action) {
  const git = simpleGit();
  const branch = (await git.branch()).current;

  if (action === 'test') {
    // Run on every commit
    await runUnitTests();
  } else if (action === 'deploy' && branch === 'production') {
    // Run on merge to production
    await runUnitTests(); // Re-run tests for safety
    const imageName = await buildDockerImage();
    await deployToK8s(imageName);
  } else {
    console.log('Invalid action or not on production branch. Skipping deployment.');
  }
}

// CLI entry point
const action = process.argv[2];
if (!action) {
  console.log('Usage: node cicd-pipeline.js <test|deploy>');
  process.exit(1);
}
main(action).catch(console.error);
