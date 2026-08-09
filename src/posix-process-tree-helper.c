#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

enum {
  SANDKING_OK = 0,
  SANDKING_IDENTITY_ABSENT = 3,
  SANDKING_UNCERTAIN = 4,
  SANDKING_SIGNAL_DELIVERED = 5,
};

enum {
  SANDKING_COMMAND_DESCRIPTOR = 6,
  SANDKING_RESULT_DESCRIPTOR = 7,
};

static int read_start_time(pid_t pid, char *result, size_t result_size) {
  char path[64];
  char stat[4096];
  int path_length = snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
  if (path_length <= 0 || (size_t)path_length >= sizeof(path)) return -1;
  int descriptor = open(path, O_RDONLY | O_CLOEXEC);
  if (descriptor < 0) return errno == ENOENT ? 0 : -1;
  ssize_t length = read(descriptor, stat, sizeof(stat) - 1);
  int read_error = errno;
  close(descriptor);
  if (length <= 0) {
    errno = read_error;
    return length == 0 || errno == ENOENT ? 0 : -1;
  }
  stat[length] = '\0';
  char *command_end = strrchr(stat, ')');
  if (command_end == NULL || command_end[1] != ' ') return -1;
  char *save = NULL;
  char *field = strtok_r(command_end + 2, " ", &save);
  for (int index = 0; field != NULL && index < 19; index += 1) {
    field = strtok_r(NULL, " ", &save);
  }
  if (field == NULL || strspn(field, "0123456789") != strlen(field)) return -1;
  if (strlen(field) + 1 > result_size) return -1;
  memcpy(result, field, strlen(field) + 1);
  return 1;
}

static int parse_signal_request(
  const char *pid_text,
  const char *signal_text,
  pid_t *pid,
  int *signal_number
) {
  char *pid_end = NULL;
  long parsed_pid = strtol(pid_text, &pid_end, 10);
  if (pid_end == pid_text || *pid_end != '\0' || parsed_pid <= 0
      || (long)(pid_t)parsed_pid != parsed_pid) {
    return 0;
  }
  int parsed_signal = strcmp(signal_text, "SIGTERM") == 0
    ? SIGTERM
    : strcmp(signal_text, "SIGKILL") == 0 ? SIGKILL : 0;
  if (parsed_signal == 0) return 0;
  *pid = (pid_t)parsed_pid;
  *signal_number = parsed_signal;
  return 1;
}

static int exact_signal_with_ptrace(
  pid_t pid,
  const char *start_time,
  int signal_number
) {
  /*
   * PTRACE_SEIZE is available on every supported kernel. The retained helper
   * is an ancestor of the complete supervised tree, so ordinary ptrace access
   * controls permit this fallback even when a system enables ancestor-only
   * attachment. Seizing before the identity read prevents exit and PID reuse
   * until the exact process has either been signalled or safely detached.
   */
  if (ptrace(PTRACE_SEIZE, pid, NULL, NULL) != 0) {
    return errno == ESRCH ? SANDKING_IDENTITY_ABSENT : SANDKING_UNCERTAIN;
  }
  if (ptrace(PTRACE_INTERRUPT, pid, NULL, NULL) != 0) {
    int interrupt_error = errno;
    (void)ptrace(PTRACE_DETACH, pid, NULL, NULL);
    return interrupt_error == ESRCH
      ? SANDKING_IDENTITY_ABSENT
      : SANDKING_UNCERTAIN;
  }

  int wait_status = 0;
  pid_t waited;
  do {
    waited = waitpid(pid, &wait_status, __WALL);
  } while (waited < 0 && errno == EINTR);
  if (waited != pid || !WIFSTOPPED(wait_status)) {
    (void)ptrace(PTRACE_DETACH, pid, NULL, NULL);
    return waited == pid && (WIFEXITED(wait_status) || WIFSIGNALED(wait_status))
      ? SANDKING_IDENTITY_ABSENT
      : SANDKING_UNCERTAIN;
  }

  char observed_start_time[64];
  int identity_status = read_start_time(pid, observed_start_time, sizeof(observed_start_time));
  if (identity_status == 0 || (identity_status == 1
      && strcmp(observed_start_time, start_time) != 0)) {
    (void)ptrace(PTRACE_DETACH, pid, NULL, NULL);
    return SANDKING_IDENTITY_ABSENT;
  }
  if (identity_status < 0) {
    (void)ptrace(PTRACE_DETACH, pid, NULL, NULL);
    return SANDKING_UNCERTAIN;
  }

  if (kill(pid, signal_number) != 0) {
    int signal_error = errno;
    (void)ptrace(PTRACE_DETACH, pid, NULL, NULL);
    return signal_error == ESRCH
      ? SANDKING_IDENTITY_ABSENT
      : SANDKING_UNCERTAIN;
  }
  if (signal_number == SIGKILL) {
    /*
     * SIGKILL is irrevocable while the revalidated tracee remains pinned. Try
     * to reap its terminal ptrace status, but keep dispatch truth independent
     * from that cleanup: a later wait error cannot unsend this exact signal.
     * The caller still confirms the complete tree from a fresh inventory before
     * publishing cancelled.
     */
    int termination_status = 0;
    do {
      waited = waitpid(pid, &termination_status, __WALL);
    } while (waited < 0 && errno == EINTR);
    return SANDKING_SIGNAL_DELIVERED;
  }
  if (ptrace(PTRACE_DETACH, pid, NULL, NULL) == 0 || errno == ESRCH) {
    return SANDKING_OK;
  }
  return SANDKING_UNCERTAIN;
}

static int exact_signal(
  const char *pid_text,
  const char *start_time,
  const char *signal_text,
  int force_ptrace
) {
  pid_t pid;
  int signal_number;
  if (!parse_signal_request(pid_text, signal_text, &pid, &signal_number)
      || start_time[0] == '\0'
      || strspn(start_time, "0123456789") != strlen(start_time)) {
    return SANDKING_UNCERTAIN;
  }

#if defined(SYS_pidfd_open) && defined(SYS_pidfd_send_signal)
  if (!force_ptrace) {
    int pidfd = (int)syscall(SYS_pidfd_open, pid, 0);
    if (pidfd < 0 && errno != ENOSYS) {
      return errno == ESRCH ? SANDKING_IDENTITY_ABSENT : SANDKING_UNCERTAIN;
    }
    if (pidfd >= 0) {
      char observed_start_time[64];
      int identity_status = read_start_time(pid, observed_start_time, sizeof(observed_start_time));
      if (identity_status == 0 || (identity_status == 1
          && strcmp(observed_start_time, start_time) != 0)) {
        close(pidfd);
        return SANDKING_IDENTITY_ABSENT;
      }
      if (identity_status < 0) {
        close(pidfd);
        return SANDKING_UNCERTAIN;
      }
      int sent = (int)syscall(SYS_pidfd_send_signal, pidfd, signal_number, NULL, 0);
      int signal_error = errno;
      close(pidfd);
      if (sent == 0) return SANDKING_OK;
      if (signal_error != ENOSYS) {
        return signal_error == ESRCH
          ? SANDKING_IDENTITY_ABSENT
          : SANDKING_UNCERTAIN;
      }
    }
  }
#else
  (void)force_ptrace;
#endif

  return exact_signal_with_ptrace(pid, start_time, signal_number);
}

static int write_all(int descriptor, const char *value, size_t length) {
  size_t written = 0;
  while (written < length) {
    ssize_t result = write(descriptor, value + written, length - written);
    if (result > 0) {
      written += (size_t)result;
      continue;
    }
    if (result < 0 && errno == EINTR) continue;
    return 0;
  }
  return 1;
}

static void write_signal_result(const char *request_id, int status) {
  char result[128];
  int length = snprintf(result, sizeof(result), "%s %d\n", request_id, status);
  if (length <= 0 || (size_t)length >= sizeof(result)) return;
  (void)write_all(SANDKING_RESULT_DESCRIPTOR, result, (size_t)length);
}

static void handle_signal_command(char *command, int force_ptrace) {
  char *save = NULL;
  char *operation = strtok_r(command, " ", &save);
  char *request_id = strtok_r(NULL, " ", &save);
  char *pid = strtok_r(NULL, " ", &save);
  char *start_time = strtok_r(NULL, " ", &save);
  char *signal_name = strtok_r(NULL, " ", &save);
  char *extra = strtok_r(NULL, " ", &save);
  if (!operation || strcmp(operation, "signal") != 0 || !request_id
      || strspn(request_id, "0123456789") != strlen(request_id)
      || !pid || !start_time || !signal_name || extra) {
    if (request_id) write_signal_result(request_id, SANDKING_UNCERTAIN);
    return;
  }
  write_signal_result(
    request_id,
    exact_signal(pid, start_time, signal_name, force_ptrace)
  );
}

/*
 * The helper is the retained child subreaper for the supervised tree. Direct
 * children cannot have their numeric PIDs reused until this process reaps
 * them, so signalling the current direct children and then repeating as their
 * children are reparented here closes the tree without a PID-reuse race. This
 * also catches descendants which left the original process group with setsid.
 */
static int signal_direct_children(void) {
  char path[96];
  int path_length = snprintf(
    path,
    sizeof(path),
    "/proc/%ld/task/%ld/children",
    (long)getpid(),
    (long)getpid()
  );
  if (path_length <= 0 || (size_t)path_length >= sizeof(path)) return 0;

  int descriptor = open(path, O_RDONLY | O_CLOEXEC);
  if (descriptor < 0) return 0;
  size_t capacity = 4096;
  size_t length = 0;
  char *children = malloc(capacity);
  if (!children) {
    close(descriptor);
    return 0;
  }
  for (;;) {
    if (length + 1 == capacity) {
      size_t next_capacity = capacity * 2;
      char *expanded = realloc(children, next_capacity);
      if (!expanded) {
        free(children);
        close(descriptor);
        return 0;
      }
      children = expanded;
      capacity = next_capacity;
    }
    ssize_t read_length = read(descriptor, children + length, capacity - length - 1);
    if (read_length > 0) {
      length += (size_t)read_length;
      continue;
    }
    if (read_length < 0 && errno == EINTR) continue;
    if (read_length < 0) {
      free(children);
      close(descriptor);
      return 0;
    }
    break;
  }
  close(descriptor);
  children[length] = '\0';

  char *cursor = children;
  while (*cursor != '\0') {
    while (*cursor == ' ') cursor += 1;
    if (*cursor == '\0') break;
    char *end = NULL;
    errno = 0;
    long parsed = strtol(cursor, &end, 10);
    if (end == cursor || errno != 0 || parsed <= 0
        || (long)(pid_t)parsed != parsed) {
      free(children);
      return 0;
    }
    if (kill((pid_t)parsed, SIGKILL) != 0 && errno != ESRCH) {
      free(children);
      return 0;
    }
    cursor = end;
  }
  free(children);
  return 1;
}

static void terminate_descendants_after_host_loss(void) {
  const struct timespec retry_delay = {
    .tv_sec = 0,
    .tv_nsec = 1000000,
  };
  for (;;) {
    (void)signal_direct_children();
    int status = 0;
    pid_t reaped;
    do {
      reaped = waitpid(-1, &status, WNOHANG);
    } while (reaped > 0);
    if (reaped < 0 && errno == ECHILD) return;
    (void)nanosleep(&retry_delay, NULL);
  }
}

static int supervise(char **supervisor_argv) {
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) {
    return SANDKING_UNCERTAIN;
  }
  const char *forced = getenv("SANDKING_TEST_PIDFD_UNAVAILABLE");
  int force_ptrace = forced && strcmp(forced, "1") == 0;

  pid_t supervisor_pid = fork();
  if (supervisor_pid < 0) return SANDKING_UNCERTAIN;
  if (supervisor_pid == 0) {
    close(SANDKING_COMMAND_DESCRIPTOR);
    close(SANDKING_RESULT_DESCRIPTOR);
    unsetenv("SANDKING_TEST_PIDFD_UNAVAILABLE");
    execv(supervisor_argv[0], supervisor_argv);
    _exit(SANDKING_UNCERTAIN);
  }

  for (int descriptor = 0; descriptor <= 5; descriptor += 1) close(descriptor);
  signal(SIGTERM, SIG_IGN);
  signal(SIGPIPE, SIG_IGN);
  signal(SIGCHLD, SIG_DFL);
  char commands[4096];
  size_t command_length = 0;
  int supervisor_status = 0;
  int supervisor_exited = 0;
  int host_lost = 0;
  while (!supervisor_exited && !host_lost) {
    struct pollfd command_poll = {
      .fd = SANDKING_COMMAND_DESCRIPTOR,
      .events = POLLIN,
      .revents = 0,
    };
    int poll_result = poll(&command_poll, 1, 50);
    if (poll_result > 0 && (command_poll.revents & POLLIN)) {
      ssize_t read_length = read(
        SANDKING_COMMAND_DESCRIPTOR,
        commands + command_length,
        sizeof(commands) - command_length
      );
      if (read_length > 0) {
        command_length += (size_t)read_length;
        char *newline;
        while ((newline = memchr(commands, '\n', command_length)) != NULL) {
          size_t line_length = (size_t)(newline - commands);
          *newline = '\0';
          handle_signal_command(commands, force_ptrace);
          size_t consumed = line_length + 1;
          memmove(commands, commands + consumed, command_length - consumed);
          command_length -= consumed;
        }
        if (command_length == sizeof(commands)) command_length = 0;
      } else if (read_length == 0) {
        host_lost = 1;
      }
    }
    if (poll_result > 0
        && (command_poll.revents & (POLLHUP | POLLERR | POLLNVAL))) {
      host_lost = 1;
    }

    int status = 0;
    pid_t reaped;
    do {
      reaped = waitpid(-1, &status, WNOHANG);
      if (reaped == supervisor_pid) {
        supervisor_status = status;
        supervisor_exited = 1;
      }
    } while (reaped > 0);
  }
  if (host_lost) terminate_descendants_after_host_loss();
  close(SANDKING_COMMAND_DESCRIPTOR);
  close(SANDKING_RESULT_DESCRIPTOR);
  if (host_lost) return 128 + SIGKILL;
  if (WIFEXITED(supervisor_status)) return WEXITSTATUS(supervisor_status);
  if (WIFSIGNALED(supervisor_status)) return 128 + WTERMSIG(supervisor_status);
  return SANDKING_UNCERTAIN;
}

int main(int argc, char **argv) {
  if (argc >= 4 && strcmp(argv[1], "subreaper") == 0) {
    return supervise(&argv[2]);
  }
  if (argc == 5 && strcmp(argv[1], "signal") == 0) {
    return exact_signal(argv[2], argv[3], argv[4], 0);
  }
  return SANDKING_UNCERTAIN;
}
