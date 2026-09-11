/*
 * D1-05 §10 / §11：macOS 凭据存储——进程内访问原型。
 *
 * 为什么要写这个：
 *   /usr/bin/security 的 -w / -p / -X 全部把密钥放进 **argv**，同 uid 的任何进程
 *   都能用 ps 读到（Apple 自带帮助文本明确写了 "Use of the -p or -w options is
 *   insecure"）。所以 CLI 不能作为产品实现路径。
 *   正确路径是进程内调用 Security.framework：密钥只经 **stdin** 送入，
 *   不进 argv、不进环境变量、不落磁盘明文。
 *
 * 协议（stdin 一行一条，stdout 一行一条）：
 *   PUT <service> <value>    → OK | ERR <osstatus>
 *   GET <service>            → VALUE <value> | NONE | ERR <osstatus>
 *   DEL <service>            → OK | NONE | ERR <osstatus>
 *   PING                     → PONG
 *
 * value 用 base64url 字符集、不含空格，故可直接做行内 token。
 * 本程序只在 D1-05 探针中被使用；它不是产品代码。
 */
#include <stdio.h>
#include <string.h>
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>

#define LINE 16384

static CFStringRef cfstr(const char *s) {
  return CFStringCreateWithCString(NULL, s, kCFStringEncodingUTF8);
}

/* 统一的查询字典：class=genp + service + account。 */
static CFMutableDictionaryRef query(const char *service) {
  CFMutableDictionaryRef q = CFDictionaryCreateMutable(
      NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFDictionarySetValue(q, kSecClass, kSecClassGenericPassword);

  CFStringRef svc = cfstr(service);
  CFStringRef acct = cfstr("openarc-d1-05");
  CFDictionarySetValue(q, kSecAttrService, svc);
  CFDictionarySetValue(q, kSecAttrAccount, acct);
  CFRelease(svc);
  CFRelease(acct);
  return q;
}

/* 去掉行尾 \r\n */
static void chomp(char *s) {
  size_t n = strlen(s);
  while (n && (s[n - 1] == '\n' || s[n - 1] == '\r')) s[--n] = '\0';
}

static int do_put(const char *service, const char *value) {
  CFMutableDictionaryRef q = query(service);

  CFDataRef data = CFDataCreate(NULL, (const UInt8 *)value, (CFIndex)strlen(value));
  CFDictionarySetValue(q, kSecValueData, data);
  CFDictionarySetValue(q, kSecAttrAccessible, kSecAttrAccessibleWhenUnlocked);

  /* upsert：先删旧的，再写新的（不依赖 CLI 的 -U） */
  SecItemDelete(q);
  OSStatus st = SecItemAdd(q, NULL);

  CFRelease(data);
  CFRelease(q);

  if (st == errSecSuccess) {
    printf("OK\n");
    return 0;
  }
  printf("ERR %d\n", (int)st);
  return 1;
}

static int do_get(const char *service) {
  CFMutableDictionaryRef q = query(service);
  CFDictionarySetValue(q, kSecReturnData, kCFBooleanTrue);
  CFDictionarySetValue(q, kSecMatchLimit, kSecMatchLimitOne);

  CFTypeRef out = NULL;
  OSStatus st = SecItemCopyMatching(q, &out);
  CFRelease(q);

  if (st == errSecItemNotFound) {
    printf("NONE\n");
    return 0;
  }
  if (st != errSecSuccess || out == NULL) {
    printf("ERR %d\n", (int)st);
    return 1;
  }

  CFDataRef d = (CFDataRef)out;
  CFIndex len = CFDataGetLength(d);
  const UInt8 *p = CFDataGetBytePtr(d);

  /* 明文只回给**自己的调用方**（父进程的 stdin/stdout 管道），不落盘、不进日志。 */
  fputs("VALUE ", stdout);
  fwrite(p, 1, (size_t)len, stdout);
  fputc('\n', stdout);
  CFRelease(out);
  return 0;
}

static int do_del(const char *service) {
  CFMutableDictionaryRef q = query(service);
  OSStatus st = SecItemDelete(q);
  CFRelease(q);

  if (st == errSecSuccess) {
    printf("OK\n");
    return 0;
  }
  if (st == errSecItemNotFound) {
    printf("NONE\n");
    return 0;
  }
  printf("ERR %d\n", (int)st);
  return 1;
}

int main(void) {
  /* 立刻关掉 stdout 缓冲，保证父进程能按行实时读；stderr 留作诊断。 */
  setvbuf(stdout, NULL, _IOLBF, 0);

  char line[LINE];
  while (fgets(line, sizeof(line), stdin)) {
    chomp(line);
    if (line[0] == '\0') continue;

    char *sp = strchr(line, ' ');
    char *cmd = line;
    char *rest = NULL;
    if (sp) {
      *sp = '\0';
      rest = sp + 1;
    }

    if (strcmp(cmd, "PING") == 0) {
      printf("PONG\n");
    } else if (strcmp(cmd, "PUT") == 0 && rest) {
      char *sp2 = strchr(rest, ' ');
      if (!sp2) {
        printf("ERR 0 bad-args\n");
      } else {
        *sp2 = '\0';
        do_put(rest, sp2 + 1);
      }
    } else if (strcmp(cmd, "GET") == 0 && rest) {
      do_get(rest);
    } else if (strcmp(cmd, "DEL") == 0 && rest) {
      do_del(rest);
    } else {
      printf("ERR 0 unknown-cmd\n");
    }
    fflush(stdout);
  }
  return 0;
}
