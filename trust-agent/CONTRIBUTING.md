Contributing to TrustAgentAI

First of all, thank you for your interest in TrustAgentAI! We welcome contributions from everyone—whether it's fixing a typo in the documentation or implementing complex cryptographic primitives.

As a project focused on security, liability, and execution integrity, we maintain high standards for code quality and safety.

🚀 Getting Started

1. Find an Issue

Browse our Issue Tracker. Look for issues labeled good first issue if you are new to the project.

2. Report a Bug

If you've found a bug, please create an issue using the "Bug Report" template. Include steps to reproduce the behavior and describe the expected outcome.

🛠️ Development Process

The current reference implementation is **TypeScript (Node.js ≥ 18)**. A high-performance Rust rewrite is planned for production deployments; see the roadmap section below.

Environment Requirements:

Node.js ≥ 18 (LTS recommended)

npm ≥ 9

TypeScript 5+ (installed as a devDependency — no global install needed)

Project Setup:

Fork the repository on GitHub.

Clone it locally: git clone https://github.com/kirbas/trustagent-a2a-protocol.git

Install dependencies: npm install

Create a new feature branch: git checkout -b feat/your-feature-name

Coding Standards:

Before submitting your code, ensure it passes our automated quality gates:

Type-checking: npm run build:check (tsc --noEmit — must produce zero errors).

Build: npm run build (compiles src/ into dist/).

Integration tests: npm run example and npm run proxy:test must complete without errors.

🦀 Roadmap: Rust Production Runtime

The long-term architecture targets a **Rust-based sidecar proxy** for maximum throughput, memory safety, and predictable latency in high-frequency agentic environments. The TypeScript implementation is the canonical protocol reference and will remain the primary contribution target until the Rust port reaches feature parity.

📥 Submitting a Pull Request (PR)

Ensure your PR addresses a single, specific task or bug fix.

Provide a clear description of the changes in the PR body.

If your changes affect the A2A protocol, ensure you update the documentation in the /docs folder.

Wait for a review from the maintainers. Be prepared to discuss your implementation and make adjustments.

🔒 Security First

IMPORTANT: If you discover a security vulnerability in the protocol or the proxy, do not open a public issue.

Please send a detailed report to security@trustagentai.net or use GitHub's Private Vulnerability Reporting feature. We follow a Responsible Disclosure policy and will credit researchers who help us keep the protocol secure.

📜 Code of Conduct

We aim to foster an open and welcoming community. Please be professional and respectful to all participants, regardless of their experience level or background.

Join us in building the accountability standard for the Agentic Economy! 🤖🛡️

License: By contributing to TrustAgentAI, you agree that your contributions will be licensed under the Apache License 2.0.
