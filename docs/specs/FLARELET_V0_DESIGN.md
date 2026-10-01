# Flarelet v0 Design Specification

> Cloudflare-like developer experience on AWS Serverless.

## 1. Vision

Flarelet is an AWS Serverless Application Platform that lets developers deploy applications without writing AWS infrastructure code.

The normal user-facing surface is intentionally small:

```text
flarelet.yaml
application code
flarelet CLI
```

Users should not normally need to write or understand CDK, CloudFormation, IAM, API Gateway, Lambda packaging, DynamoDB tables, Cognito, or CloudWatch configuration.

Flarelet is **not** a generic AWS abstraction layer and **not** another CDK construct library. Its product is the developer experience: `dev`, `deploy`, authentication, bindings, previews, logs, secrets, environments, and safe serverless defaults.

### Core principles

1. **Serverless first.** Golden Path resources are managed/serverless AWS services.
2. **No user-written IaC.** Users declare application capabilities, not AWS resources.
3. **Cloudflare-like DX.** Deployment and preview workflows should feel closer to Workers/Pages than traditional AWS IaC.
4. **AWS native underneath.** Prefer AWS CDK + CloudFormation for provisioning stability and state management.
5. **Safe defaults.** HTTP applications are authenticated by default.
6. **Git is first-class.** Branches and pull requests resolve naturally into stages and versions.
7. **Transparent, not exposed.** Generated Cloud Assembly remains inspectable under `.flarelet/out/`, but normal users should not need it.
8. **Narrow Golden Path.** Do not turn Flarelet into a universal AWS framework.

---

## 2. Technology decisions

### Implementation

- Language: **TypeScript**
- Configuration: **YAML**
- IaC engine: **AWS CDK**
- Provisioning/state engine: **AWS CloudFormation**
- Generated artifacts: **`.flarelet/out/`**

### Why TypeScript

CDK is a native fit for TypeScript. Keeping the CLI, configuration model, planner, constructs, and CDK integration in one language avoids a Go-to-CDK/jsii boundary and keeps AWS service adoption straightforward.

A standalone/single-executable distribution remains a desirable packaging goal, but it is not allowed to compromise the architecture. Node/npm/CDK should eventually be invisible to the end user even if they remain implementation details.

### Why CloudFormation

Flarelet deliberately does **not** own infrastructure state in v0. CloudFormation remains responsible for:

- resource state
- dependency execution
- create/update/delete
- rollback
- stabilization
- drift-related primitives
- resource imports where applicable

A cdkd-like direct AWS API deployment engine may be investigated later for faster deployments, but it is explicitly outside the v0 critical path.

---

## 3. Architecture

```text
flarelet.yaml
     │
     ▼
Config Parser + Schema Validation
     │
     ▼
Flarelet IR
     │
     ▼
Deployment Resolver / Planner
     │
     ▼
Flarelet Constructs
     │
     ▼
AWS CDK
     │
     ▼
.flarelet/out/ (Cloud Assembly)
     │
     ▼
CloudFormation
     │
     ▼
Customer AWS Account
```

The YAML schema must never be passed directly into CDK. The **Flarelet IR** is the stable boundary between the public configuration API and provisioning implementation.

---

## 4. AWS Serverless Golden Path

| Capability | Default AWS implementation |
|---|---|
| HTTP | API Gateway HTTP API |
| Compute | Lambda + Lambda Web Adapter |
| Authentication | Flarelet Auth + Cognito User Pool / Managed Login |
| Database | DynamoDB |
| Storage | S3 |
| AI | Amazon Bedrock |
| Secrets | SSM Parameter Store and/or Secrets Manager |
| Logs | CloudWatch Logs |
| Queue (post-v0) | SQS |
| Schedule (post-v0) | EventBridge Scheduler |
| Events (post-v0) | EventBridge |
| Workflow (post-v0) | Step Functions |
| Agent runtime (post-v0) | Bedrock AgentCore |

ECS, EKS, EC2, RDS, arbitrary VPC design, Terraform, multi-cloud, and a custom state engine are not part of the v0 Golden Path.

---

## 5. `flarelet.yaml` v0

A representative application:

```yaml
version: 1

name: myapp

runtime:
  language: python
  version: "3.13"

http:
  auth: true

database:
  main: {}

storage:
  files: {}

ai:
  models:
    - sonnet

secrets:
  - EXTERNAL_API_KEY

git:
  production:
    branch: "release/*"
    version: branch

  preview:
    branch: default

  pullRequests: true
```

The public schema describes capabilities. Avoid AWS resource names such as `lambda`, `dynamodb`, `apiGateway`, or `cognito` in the normal configuration model.

### Runtime

Initial application runtimes:

```yaml
runtime:
  language: typescript
```

or:

```yaml
runtime:
  language: python
  version: "3.13"
```

Convention should be preferred over explicit entrypoint configuration. Additional runtimes can be added later.

### HTTP

```yaml
http: true
```

should mean an HTTP application with **authentication enabled by default**.

Unauthenticated public exposure must be explicit:

```yaml
http:
  auth: false
```

### Database

```yaml
database:
  users: {}
  sessions: {}
```

Flarelet creates the required DynamoDB resources, grants least-privilege access, and exposes binding metadata. It does not create a replacement database SDK in v0.

### Storage

```yaml
storage:
  uploads: {}
  exports: {}
```

Flarelet creates S3 resources and corresponding bindings/IAM permissions.

### AI

```yaml
ai:
  models:
    - sonnet
    - nova-micro
```

Logical model names are resolved through a Flarelet model registry to concrete Bedrock model identifiers. Applications should not need to embed changing Bedrock model IDs in configuration.

### Secrets

```yaml
secrets:
  - EXTERNAL_API_KEY
```

Secret values never belong in `flarelet.yaml`.

```bash
flarelet secret set EXTERNAL_API_KEY
flarelet secret list
flarelet secret delete EXTERNAL_API_KEY
```

The application consumes them as normal environment variables.

---

## 6. Authentication

Authentication is a **v0 core capability**, not an optional future feature.

The desired experience is analogous to placing Cloudflare Access in front of an application: a developer can casually publish an internal application without separately building login/session infrastructure.

### Architecture

```text
Browser
   │
   ▼
Flarelet Auth Layer
   │
   ├── unauthenticated ──► Cognito Managed Login
   │                           │
   │                      Google / Entra / OIDC / SAML
   │                           │
   ◄──────── callback ─────────┘
   │
   ▼
Application
```

Cognito acts as the identity/federation engine. Flarelet owns the application-protection experience: redirects, callback handling, session behavior, and exposing authenticated identity to the application.

Possible internal endpoints:

```text
/__flarelet/auth/login
/__flarelet/auth/callback
/__flarelet/auth/logout
```

### Configuration

Default:

```yaml
http:
  auth: true
```

External identity provider examples:

```yaml
http:
  auth:
    provider: google
```

```yaml
http:
  auth:
    provider: oidc
```

Credentials are supplied through Flarelet secrets rather than YAML.

### Application identity

Flarelet should expose normalized identity to applications, for example through runtime bindings or trusted request context/headers. Applications should not have to implement the OIDC flow themselves.

### Custom domains

Custom domains are **not a v0 product priority**. They may be implemented if required for a clean authentication/callback architecture. The default Flarelet deployment should work without requiring the user to own/configure a domain.

---

## 7. Deployment model: App → Stage → Version

This is a fundamental Flarelet concept.

```text
Application
   │
   ├── Stage
   │    ├── prod
   │    └── preview
   │
   └── Version / Deployment
        ├── v1
        ├── v2
        ├── pr-123
        └── pr-456
```

### Semantics

- **App**: the logical application.
- **Stage**: policy/lifecycle boundary such as `prod`, `preview`, `development`.
- **Version**: a deployable generation within a stage, such as `v1`, `v2`, `current`, or `pr-123`.

Git does not define the infrastructure model directly. Git refs are inputs to a **Deployment Resolver** that resolves a `stage + version`.

```text
Git ref / CLI args
       │
       ▼
Deployment Resolver
       │
       ├── stage
       └── version
              │
              ▼
        Flarelet Deployment
```

This keeps the model usable outside GitHub as well:

```bash
flarelet deploy --stage prod --version v3
```

---

## 8. Git integration

Git integration is a first-class Flarelet feature rather than CI glue added later.

### Default behavior

With minimal/no custom Git mapping:

```text
default branch → production/current
pull request   → preview/pr-{number}
```

### Configurable branch mapping

A preferred personal workflow can be represented as:

```yaml
git:
  production:
    branch: "release/*"
    version: branch

  preview:
    branch: default

  pullRequests: true
```

Resolution example:

```text
main        → preview/current
release/v1  → prod/v1
release/v2  → prod/v2
PR #123     → preview/pr-123
```

The exact schema may evolve during implementation, but the resolver semantics are part of the v0 design.

### Persistent branches

Fixed branches may own persistent environments, e.g.:

```text
main     → preview/current
develop  → development/current
```

They remain deployed until explicitly removed or their configured lifecycle changes.

### Pull request previews

PR environments are ephemeral:

```text
PR opened
   ↓
preview/pr-123 created
   ↓
push / synchronize
   ↓
preview updated
   ↓
PR closed or merged
   ↓
preview destroyed
```

The resulting URL should be surfaced directly in the GitHub PR through a Check, Deployment, and/or comment.

### Execution model

The preferred v0 architecture avoids requiring a central Flarelet SaaS control plane:

```text
GitHub event
    │
    ▼
GitHub Actions
    │
    │ OIDC
    ▼
Customer AWS account
    │
    ▼
flarelet deploy
```

GitHub Actions uses OIDC to assume an AWS IAM role, avoiding long-lived AWS access keys.

A GitHub App may later improve installation, repository access checks, PR UI, and lifecycle orchestration, but the deployment execution can remain in GitHub Actions/customer AWS.

---

## 9. Preview authentication

Production authentication and ephemeral preview authentication have different constraints.

Dynamic PR URLs can be awkward for external OAuth/OIDC callback allowlists. Therefore Flarelet may use a simpler preview-specific authentication mode.

Recommended policy:

```text
production / persistent stage
    → Cognito + configured federated identity

PR preview
    → Flarelet Preview Auth
```

Initial Preview Auth may be simple password/token protection. A stronger future option is GitHub authentication combined with repository-access authorization:

```text
Preview URL
   ↓
Sign in with GitHub
   ↓
Verify repository access
   ↓
Preview application
```

The key v0 requirement is that PR previews are **not accidentally unauthenticated public applications**.

---

## 10. Resource lifecycle scopes

Versioned serverless deployments make it cheap and useful to create multiple stacks, but stateful resources should not always be duplicated with compute.

Flarelet therefore distinguishes **stage-scoped** and **version-scoped** resources.

Recommended defaults for persistent stages:

| Capability | Default scope |
|---|---|
| Compute | version |
| HTTP deployment | version |
| Database | stage |
| Storage | stage |
| Auth | stage |
| Secrets | stage |

Conceptually:

```text
prod
├── Auth
├── Database
├── Storage
├── Secrets
│
├── v1
│   ├── HTTP
│   └── Compute
│
└── v2
    ├── HTTP
    └── Compute
```

This makes blue/green deployment and rollback practical without implicitly cloning production data.

### PR previews

PR previews prioritize isolation. Their default can be effectively version-scoped for the whole preview environment:

```text
preview/pr-123
├── HTTP
├── Compute
├── Database (empty)
├── Storage (empty)
└── Preview Auth
```

Production data must never be cloned into preview environments by default.

A future manifest option may allow explicit lifecycle control:

```yaml
database:
  main:
    lifecycle: stage
```

This should only be exposed when a real need appears; sensible defaults are preferred in v0.

---

## 11. Future promotion and rollback model

`App → Stage → Version` intentionally leaves room for immutable/blue-green production deployments.

Example:

```text
prod/v1  (existing)
prod/v2  (new)
```

A future command could switch routing rather than mutate the old compute deployment:

```bash
flarelet promote prod/v2
```

and rollback could switch traffic back to an already-deployed version:

```bash
flarelet rollback
```

This is different from relying solely on CloudFormation rollback: it treats deployed application versions as first-class entities.

Promotion/traffic switching is not required for the first PoC, but the v0 resource model must not prevent it.

---

## 12. Local development

`flarelet dev` is a core product experience.

Recommended model:

```text
Developer machine
│
├── local application (FastAPI / Hono / etc.)
│
└── Flarelet bindings
        │
        ▼
AWS development/preview resources
├── DynamoDB
├── S3
└── Bedrock
```

Do not make LocalStack, DynamoDB Local, or a complete AWS emulator a v0 dependency. Prefer a local application connected to real isolated AWS serverless resources.

Example UX:

```text
$ flarelet dev

Flarelet dev

App       myapp
Stage     preview
Version   local-naoto
Runtime   python 3.13
URL       http://localhost:8787

Bindings
  database.main    connected
  storage.files    connected
  ai.sonnet        connected

Watching...
```

---

## 13. Runtime bindings

Flarelet is responsible for:

- resource discovery
- normalized configuration
- least-privilege IAM
- environment/runtime bindings

It should **not** reimplement AWS service APIs in v0.

Example TypeScript concept:

```ts
import { bindings } from "@flarelet/runtime";

const db = bindings.database("main");
const storage = bindings.storage("files");
```

These bindings expose resource metadata needed by the normal AWS SDK. Database CRUD, S3 operations, etc. remain AWS SDK operations.

Secrets may simply appear as environment variables.

---

## 14. CLI v0

```text
flarelet init
flarelet dev

flarelet plan
flarelet deploy
flarelet destroy

flarelet env list

flarelet logs

flarelet secret set
flarelet secret list
flarelet secret delete

flarelet synth
```

### `flarelet plan`

`plan` should translate infrastructure changes back into Flarelet concepts rather than dumping raw CloudFormation noise.

Example:

```text
Flarelet will update myapp (prod/v2)

  + application version v2
  = database.main
  = storage.files
  = authentication

1 deployment change

Deploy with:
  flarelet deploy --stage prod --version v2
```

### `flarelet env list`

Example:

```text
STAGE        VERSION   TYPE         SOURCE          STATUS
prod         v1        persistent   release/v1      ready
preview      current   persistent   main            ready
preview      pr-123    ephemeral    feature/login   ready
preview      pr-128    ephemeral    fix/header      deploying
```

---

## 15. Generated project layout

Application repository:

```text
myapp/
├── flarelet.yaml
├── app/
├── .github/
│   └── workflows/
│       └── flarelet.yml
└── .flarelet/
    ├── out/
    ├── cache/
    └── metadata.json
```

`.flarelet/out/` contains the generated CDK Cloud Assembly and related artifacts. `flarelet synth` exposes this layer for debugging and inspection.

---

## 16. Suggested Flarelet repository structure

Keep the initial repository relatively simple:

```text
flarelet/
├── src/
│   ├── cli/
│   ├── config/
│   ├── ir/
│   ├── resolver/
│   ├── planner/
│   ├── constructs/
│   ├── auth/
│   ├── runtime/
│   └── git/
├── examples/
├── package.json
├── tsconfig.json
└── mise.toml
```

Avoid premature package/monorepo fragmentation. Split packages only when the runtime SDK, GitHub integration, or reusable constructs genuinely need independent release boundaries.

---

## 17. v0 scope

### Must have

- TypeScript Flarelet CLI
- `flarelet.yaml` parser/schema
- Flarelet IR
- CDK/CloudFormation synthesis and deployment
- `.flarelet/out/`
- Lambda + Lambda Web Adapter
- API Gateway HTTP API
- authenticated HTTP applications
- Cognito-backed Flarelet Auth for persistent environments
- preview-safe authentication
- DynamoDB binding
- S3 binding
- Bedrock model binding
- secrets
- CloudWatch log tailing
- App → Stage → Version model
- Git branch resolver
- PR preview create/update/destroy lifecycle
- GitHub Actions + AWS OIDC deployment path

### Explicitly not v0

- Terraform/CDKTF/OpenTofu
- custom infrastructure state engine
- cdkd-style direct provisioning
- ECS/EKS/EC2
- RDS
- arbitrary VPC topology
- multi-cloud
- web management console
- full local AWS emulator
- custom domain as a headline feature
- generic user-auth SDK/database abstraction
- arbitrary CDK escape hatch
- production data cloning into previews

---

## 18. PoC sequence

### PoC 1 — Basic deployment

```text
flarelet.yaml
   ↓
flarelet deploy
   ↓
API Gateway + Lambda/LWA
   ↓
working HTTPS URL
```

### PoC 2 — Auth

```text
http.auth: true
   ↓
Cognito + Flarelet Auth
   ↓
open URL
   ↓
login
   ↓
application
```

### PoC 3 — Bindings

Add DynamoDB, S3, Bedrock, and secrets with automatically generated IAM.

### PoC 4 — Stage/version

Verify:

```text
main       → preview/current
release/v1 → prod/v1
release/v2 → prod/v2
```

with stage-scoped stateful resources and version-scoped compute.

### PoC 5 — Pull request preview

```text
PR open
  ↓
automatic preview/pr-N deployment
  ↓
protected preview URL appears in GitHub
  ↓
PR update redeploys
  ↓
PR close destroys preview
```

If this workflow feels fast and boring to use, the core Flarelet thesis is validated.

---

## 19. DX success criteria

Initial targets, to be validated rather than treated as hard guarantees:

- New project initialization: approximately < 1 minute
- Local application startup: approximately < 5 seconds
- Initial serverless deployment: target < 2 minutes
- Repeat deployment: target < 30 seconds where CloudFormation permits
- Log tail availability: target < 3 seconds
- Add/update secret: one command
- PR preview: automatic from Git lifecycle
- Normal AWS Console operations: zero
- User-written CDK: zero
- User-written IAM: zero
- Long-lived AWS access keys for CI: zero

Deployment speed is expected to be one of the largest differences versus Cloudflare. Do not compromise state/provisioning reliability in v0 merely to hit an artificial speed target.

---

## 20. Key architectural invariants

These should be treated as design guardrails:

1. A user should not need to know which AWS service implements a normal Flarelet capability.
2. Flarelet IR is the boundary between public configuration and CDK implementation.
3. CloudFormation owns infrastructure state in v0.
4. Git refs resolve to `stage + version`; Git branch names are not themselves the infrastructure model.
5. Stateful production resources are not duplicated per version by default.
6. PR previews are isolated and do not clone production data by default.
7. HTTP exposure is authenticated by default.
8. Authentication implementation must not leak into application code for normal use cases.
9. Custom domains are optional, not required for the core experience unless technically necessary for authentication.
10. New AWS capabilities should be added only when they fit the serverless Golden Path.

---

## 21. Product definition

A concise working definition:

> **Flarelet is a serverless application platform for AWS. Define what your application needs in YAML, push your code, and Flarelet handles infrastructure, authentication, previews, deployment, and runtime bindings.**

The intended developer mental model is:

```text
flarelet.yaml

flarelet init
flarelet dev
flarelet deploy
flarelet logs
```

not:

```text
CDK
CloudFormation
IAM
API Gateway
Lambda packaging
Cognito
DynamoDB provisioning
```

That distinction is the reason Flarelet exists.
