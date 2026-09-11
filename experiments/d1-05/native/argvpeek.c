/*
 * D1-05 §11 / §12：读另一个进程的 argv / env 的取证工具。
 *
 * 为什么不用 /bin/ps：
 *   本机 /bin/ps 是 setuid root（-rwsr-xr-x root wheel），在本环境中被禁止执行
 *   （operation not permitted），因此无法用它测量"密钥是否出现在进程表里"。
 *
 * 改用 sysctl(KERN_PROCARGS2)：**同 uid 不需要 root** 即可读取目标进程的命令行
 * 与环境块，正是攻击者会走的路。所以它就是我们要测的那条路。
 *
 * 用法：argvpeek <pid> [maxMs]
 *   打印目标进程的 argv（每行一个）。
 *   给了 maxMs 时在窗口内反复重试（用于抢短命进程，如 /usr/bin/security）。
 * 退出码：0 读到  1 超时/空  2 参数错  3 进程不存在
 *
 * 用法：argvpeek -e <pid>
 *   额外把环境块（env）以 `ENV key=value` 形式打印出来，
 *   用于验证"子进程是否继承了不该继承的环境变量"。
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#define BUFSZ (1024 * 1024)
static char buf[BUFSZ];

static size_t peek(pid_t pid) {
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, (int)pid};
  size_t sz = BUFSZ;
  if (sysctl(mib, 3, buf, &sz, NULL, 0) != 0) return 0;
  return sz;
}

static long elapsed_ms(const struct timespec *start) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (now.tv_sec - start->tv_sec) * 1000L + (now.tv_nsec - start->tv_nsec) / 1000000L;
}

int main(int argc, char **argv) {
  int dumpEnv = 0;
  int argi = 1;
  if (argc > 1 && strcmp(argv[1], "-e") == 0) {
    dumpEnv = 1;
    argi = 2;
  }
  if (argc <= argi) {
    fprintf(stderr, "usage: argvpeek [-e] <pid> [maxMs]\n");
    return 2;
  }
  pid_t pid = (pid_t)atoi(argv[argi]);
  long maxMs = argc > argi + 1 ? atol(argv[argi + 1]) : 0;

  struct timespec start;
  clock_gettime(CLOCK_MONOTONIC, &start);

  for (;;) {
    size_t len = peek(pid);
    if (len > sizeof(int)) {
      int argc_n = 0;
      memcpy(&argc_n, buf, sizeof(int));
      char *p = buf + sizeof(int);
      char *end = buf + len;

      /* 跳过可执行文件路径 */
      while (p < end && *p) p++;
      /* 跳过 exec_path 与 argv[0] 之间的 NUL 填充 */
      while (p < end && *p == '\0') p++;

      int printed = 0;
      for (int i = 0; i < argc_n && p < end; i++) {
        printf("%s\n", p);
        while (p < end && *p) p++;
        while (p < end && *p == '\0') p++;
        printed++;
      }
      if (printed > 0) {
        if (dumpEnv) {
          /* argv 之后紧跟环境块，直到 apple 向量或缓冲区末尾 */
          for (int guard = 0; guard < 4096 && p < end; guard++) {
            if (*p == '\0') break;
            printf("ENV %s\n", p);
            while (p < end && *p) p++;
            while (p < end && *p == '\0') {
              p++;
              /* 连续两个 NUL 说明环境块结束 */
              if (p < end && *p == '\0') {
                p = end;
                break;
              }
            }
          }
        }
        return 0;
      }
    } else if (errno == ESRCH) {
      return 3;
    }

    if (maxMs <= 0) return 1;
    if (elapsed_ms(&start) >= maxMs) return 1;
    usleep(200);
  }
}
