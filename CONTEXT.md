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

**Project registration**:
The Host's record of a Project at a particular location, including which Harness it uses. Moving or replacing the Project at that location is resolved by the person and Controller rather than inferred by Sand-King.
_Avoid_: Project manifest, project identity file

**Harness**:
A named, independently identifiable body of tooling that can be linked to one or more Project registrations and used to run Workers. A Harness may be reused or forked independently of any Project.
_Avoid_: Project harness, harness template

**Harness workspace**:
The Controller-editable, version-controlled home of a Harness, maintained by Sand-King separately from Projects and their execution state.
_Avoid_: `.sandcastle/`, generated harness

**Worker**:
An agent invoked by the host to carry out delegated coding work on a project through its harness.
_Avoid_: Inner agent, coding agent, sub-agent

**Harness run**:
A Controller-launched period in which a Project's pinned Harness performs delegated work under Host supervision. The Harness defines the work and its internal structure.
_Avoid_: Worker, task, agent session

**Harness adapter**:
The versioned Harness entry point through which a Host launches, observes, and cancels a Harness run without interpreting the Harness's workflow.
_Avoid_: Run orchestrator, Sandcastle adapter

**Progress record**:
A Harness-defined description of work within a Harness run, carried in a generic Sand-King envelope for observation. Its type, status, hierarchy, and meaning belong to the Harness.
_Avoid_: Worker job, Host task

**Launch request**:
A controller-prepared proposal for starting a harness run, presented to a person for explicit approval before delegated work begins.
_Avoid_: Run command, confirmation prompt, job

**Credential transfer request**:
A proposal to install one provider's credentials from a controller machine into a host account, requiring explicit approval for the named provider and destination.
_Avoid_: Credential forwarding, secret sync, setup
