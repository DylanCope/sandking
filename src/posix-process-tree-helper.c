#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

enum {
  SANDKING_OK = 0,
  SANDKING_IDENTITY_ABSENT = 3,
  SANDKING_UNCERTAIN = 4,
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

static int exact_signal(const char *pid_text, const char *start_time, const char *signal_text) {
#if !defined(SYS_pidfd_open) || !defined(SYS_pidfd_send_signal)
  (void)pid_text;
  (void)start_time;
  (void)signal_text;
  return SANDKING_UNCERTAIN;
#else
  char *pid_end = NULL;
  long parsed_pid = strtol(pid_text, &pid_end, 10);
  if (pid_end == pid_text || *pid_end != '\0' || parsed_pid <= 0) {
    return SANDKING_UNCERTAIN;
  }
  int signal_number = strcmp(signal_text, "SIGTERM") == 0
    ? SIGTERM
    : strcmp(signal_text, "SIGKILL") == 0 ? SIGKILL : 0;
  if (signal_number == 0) return SANDKING_UNCERTAIN;

  int pidfd = (int)syscall(SYS_pidfd_open, (pid_t)parsed_pid, 0);
  if (pidfd < 0) return errno == ESRCH ? SANDKING_IDENTITY_ABSENT : SANDKING_UNCERTAIN;
  char observed_start_time[64];
  int identity_status = read_start_time(
    (pid_t)parsed_pid,
    observed_start_time,
    sizeof(observed_start_time)
  );
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
  return signal_error == ESRCH ? SANDKING_IDENTITY_ABSENT : SANDKING_UNCERTAIN;
#endif
}

int main(int argc, char **argv) {
  if (argc >= 4 && strcmp(argv[1], "subreaper") == 0) {
    if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) return SANDKING_UNCERTAIN;
    execv(argv[2], &argv[2]);
    return SANDKING_UNCERTAIN;
  }
  if (argc == 5 && strcmp(argv[1], "signal") == 0) {
    return exact_signal(argv[2], argv[3], argv[4]);
  }
  return SANDKING_UNCERTAIN;
}
