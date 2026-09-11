/*
 * D1-05 §15 / §21：OS 级资源约束的执行包装器。
 *
 * 为什么需要它：
 *   本机（WorkBuddy 沙箱内）**无法应用更严格的 seatbelt profile**——
 *   sandbox-exec 一律返回 `sandbox_apply: Operation not permitted`，
 *   所以"进程级文件/网络沙箱"这条 OS 级路线在本机实测受阻（BLOCKED）。
 *
 *   但 rlimit 是另一类**真正由内核强制**的约束，且不需要 root。
 *   它恰好覆盖 §21 要求的 timeout / memory / CPU / file-size 四项，
 *   并且能证明一个关键差异：JS 层的 setTimeout 与计数只是"防呆"，
 *   内核的 SIGXCPU / SIGXFSZ / ENOMEM 是"约束"。
 *
 * 用法：
 *   rlimit-exec <key=value>... -- <cmd> [args...]
 * 支持的 key：
 *   as      地址空间上限（字节）      → 超限分配失败
 *   cpu     CPU 时间上限（秒）        → 超限收到 SIGXCPU
 *   fsize   单文件写入上限（字节）     → 超限收到 SIGXFSZ
 *   nofile  打开文件数上限
 *   nproc   进程/线程数上限           → 超限 fork 失败
 *
 * 本程序只在 D1-05 探针中被使用；它不是产品代码。
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <unistd.h>

static int apply(const char *spec) {
  char *eq = strchr(spec, '=');
  if (!eq) {
    fprintf(stderr, "bad spec: %s\n", spec);
    return -1;
  }
  size_t klen = (size_t)(eq - spec);
  char key[32];
  if (klen >= sizeof(key)) return -1;
  memcpy(key, spec, klen);
  key[klen] = '\0';
  long long v = atoll(eq + 1);

  int what;
  if (strcmp(key, "as") == 0) what = RLIMIT_AS;
  else if (strcmp(key, "cpu") == 0) what = RLIMIT_CPU;
  else if (strcmp(key, "fsize") == 0) what = RLIMIT_FSIZE;
  else if (strcmp(key, "nofile") == 0) what = RLIMIT_NOFILE;
  else if (strcmp(key, "nproc") == 0) what = RLIMIT_NPROC;
  else {
    fprintf(stderr, "unknown key: %s\n", key);
    return -1;
  }

  struct rlimit rl;
  rl.rlim_cur = (rlim_t)v;
  rl.rlim_max = (rlim_t)v;
  if (setrlimit(what, &rl) != 0) {
    fprintf(stderr, "setrlimit(%s) failed: %s\n", key, strerror(errno));
    return -1;
  }
  return 0;
}

int main(int argc, char **argv) {
  int i = 1;
  for (; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) {
      i++;
      break;
    }
    if (apply(argv[i]) != 0) return 2;
  }
  if (i >= argc) {
    fprintf(stderr, "usage: rlimit-exec <key=value>... -- <cmd> [args...]\n");
    return 2;
  }

  execvp(argv[i], &argv[i]);
  fprintf(stderr, "exec failed: %s\n", strerror(errno));
  return 127;
}
