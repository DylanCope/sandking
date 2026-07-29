# Sand-King

Sand-King coordinates interactive development across projects and delegates durable coding work to project-adjacent agent harnesses.

## Language

**Sand-King**:
The developer agent system through which a person opens projects, directs development, and delegates durable coding work.
_Avoid_: Sandking, universal harness, control plane

**Controller**:
The interactive agent through which a person directs work across projects. A controller may connect from a different machine than the project.
_Avoid_: Architect, client agent, master agent

**Host**:
The Sand-King presence in the environment where a project and its development tools reside. It retains project execution state independently of any controller.
_Avoid_: Remote host, server, controller host

**Project**:
A codebase opened through Sand-King for inspection, direct development, or delegated work, whether local to the controller or reached over SSH.
_Avoid_: Workspace, repository, checkout

**Worker**:
An agent invoked by the host to carry out delegated coding work on a project through its harness.
_Avoid_: Inner agent, coding agent, sub-agent

**Harness run**:
A controller-launched period of delegated work in which a project's harness plans and advances eligible work from its issue tracker.
_Avoid_: Worker, task, agent session

**Launch request**:
A controller-prepared proposal for starting a harness run, presented to a person for explicit approval before delegated work begins.
_Avoid_: Run command, confirmation prompt, job

**Credential transfer request**:
A proposal to install one provider's credentials from a controller machine into a host account, requiring explicit approval for the named provider and destination.
_Avoid_: Credential forwarding, secret sync, setup

**Worker job**:
The execution and review of one issue within a harness run.
_Avoid_: Harness run, controller task
