#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sched.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <linux/sockios.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

// Linux 6.1 headers omit the ABI 3 constant; the runtime kernel version is checked before use.
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (UINT64_C(1) << 14)
#endif
// Calls newer than those headers; their numbers are the same on every architecture.
#ifndef SYS_fchmodat2
#define SYS_fchmodat2 452
#endif
#ifndef SYS_setxattrat
#define SYS_setxattrat 463
#endif
#ifndef SYS_removexattrat
#define SYS_removexattrat 466
#endif
#ifndef SYS_file_setattr
#define SYS_file_setattr 469
#endif

static void fail(void) { perror("Native member isolation"); _exit(126); }
static void checked(long value) { if (value < 0) fail(); }
static unsigned long number(const char *text, unsigned long max) {
    char *end;
    if (!text || !*text) fail();
    unsigned long n = strtoul(text, &end, 10);
    if (*end || n == 0 || n > max) fail();
    return n;
}

static void permit(int rules, const char *path, uint64_t access, int optional) {
    int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0 && optional && (errno == ENOENT || errno == ENOTDIR)) return;
    checked(fd);
    struct landlock_path_beneath_attr attr = { .allowed_access = access, .parent_fd = fd };
    checked(syscall(SYS_landlock_add_rule, rules, LANDLOCK_RULE_PATH_BENEATH, &attr, 0));
    checked(close(fd));
}

static void port(int rules, const char *value) {
    struct { uint64_t access, port; } attr = { 2, number(value, 65535) };
    checked(syscall(SYS_landlock_add_rule, rules, 2 /* LANDLOCK_RULE_NET_PORT */, &attr, 0));
}

static void permit_under(int rules, const char *root, const char *child, uint64_t access) {
    char path[PATH_MAX];
    int length = snprintf(path, sizeof path, "%s/%s", root, child);
    if (length < 0 || (size_t)length >= sizeof path) _exit(126);
    permit(rules, path, access, 0);
}

static struct sock_filter code[160];
static unsigned short length;
static void emit(struct sock_filter instruction) { if (length == 160) _exit(126); code[length++] = instruction; }
static void deny(uint32_t call, uint32_t error) {
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, call, 0, 1));
    emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | error));
}
static void load(unsigned arg) {
    emit((struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args) + 8 * arg));
}
// The blocks below load an argument, so each returns for its own system call. After execv the worker keeps
// this process ID, and 0 also names the caller.
static void only_self(uint32_t call) {
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, call, 0, 5));
    load(0);
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 2, 0));
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)getpid(), 1, 0));
    emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM));
    emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
}
// For setpriority and ioprio_set: only the process kind of target (args[0]) naming the caller (args[1]).
static void only_self_process(uint32_t call, uint32_t kind) {
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, call, 0, 7));
    load(0);
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, kind, 0, 3));
    load(1);
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 2, 0));
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)getpid(), 1, 0));
    emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM));
    emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
}
static void refuse_commands(uint32_t call, uint32_t first, uint32_t second) {
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, call, 0, 5));
    load(1);
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, first, 2, 0));
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, second, 1, 0));
    emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
    emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM));
}
// clone only for threads; glibc starts threads with clone once clone3 reports ENOSYS.
static void threads_only(void) {
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, 4));
    load(0);
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_THREAD, 1, 0));
    emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM));
    emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
}
static void keep_death_signal(void) {
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_prctl, 0, 4));
    load(0);
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, PR_SET_PDEATHSIG, 0, 1));
    emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM));
    emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
}
// kill(0) would signal the whole supervised group, so kill and tgkill must name this process.
static void signal_only_self(void) {
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_kill, 1, 0));
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_tgkill, 0, 4));
    load(0);
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)getpid(), 1, 0));
    emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM));
    emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
}

// Descendants stay in the invocation process group supervised by the host. Pi, an offline member, also
// cannot open a socket, since its model traffic and tool calls cross descriptor 3 to the host; io_uring
// could open one without the socket call. It cannot start a process, undo its death signal, or create
// IPC objects that outlive it. It cannot signal, set limits on or reschedule any process but itself, nor
// make the kernel signal one for it through a file owner. Landlock does not mediate file metadata, so it
// also cannot change the mode, times or extended attributes of a file by path.
static void install_filter(int pi) {
    emit((struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)));
#if defined(__aarch64__)
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_AARCH64, 1, 0));
#elif defined(__x86_64__)
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0));
#else
#error Unsupported native member architecture
#endif
    emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS));
    emit((struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)));
#if defined(__x86_64__)
    // x32 numbers carry this bit and would otherwise miss every comparison below.
    emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1));
    emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM));
#endif
    deny(SYS_setsid, EPERM);
    deny(SYS_setpgid, EPERM);
    if (pi) {
        deny(SYS_socket, EPERM);
        deny(SYS_socketpair, EPERM);
        deny(SYS_io_uring_setup, EPERM);
#if defined(__x86_64__)
        deny(SYS_fork, EPERM);
        deny(SYS_vfork, EPERM);
#endif
        // glibc then starts threads with clone, which is checked below.
        deny(SYS_clone3, ENOSYS);
        deny(SYS_tkill, EPERM);
        deny(SYS_pidfd_send_signal, EPERM);
        deny(SYS_rt_sigqueueinfo, EPERM);
        deny(SYS_rt_tgsigqueueinfo, EPERM);
        deny(SYS_shmget, EPERM);
        deny(SYS_msgget, EPERM);
        deny(SYS_semget, EPERM);
        deny(SYS_mq_open, EPERM);
        deny(SYS_ptrace, EPERM);
#if defined(__x86_64__)
        deny(SYS_chmod, EPERM);
        deny(SYS_utime, EPERM);
        deny(SYS_utimes, EPERM);
        deny(SYS_futimesat, EPERM);
#endif
        deny(SYS_fchmodat, EPERM);
        deny(SYS_fchmodat2, EPERM);
        // With an empty path utimensat also works on an O_PATH descriptor, which Landlock does not check.
        deny(SYS_utimensat, EPERM);
        deny(SYS_setxattr, EPERM);
        deny(SYS_lsetxattr, EPERM);
        deny(SYS_removexattr, EPERM);
        deny(SYS_lremovexattr, EPERM);
        deny(SYS_setxattrat, EPERM);
        deny(SYS_removexattrat, EPERM);
        deny(SYS_file_setattr, EPERM);
        threads_only();
        keep_death_signal();
        signal_only_self();
        only_self(SYS_prlimit64);
        only_self(SYS_sched_setaffinity);
        only_self(SYS_sched_setattr);
        only_self(SYS_sched_setparam);
        only_self(SYS_sched_setscheduler);
        only_self_process(SYS_setpriority, PRIO_PROCESS);
        only_self_process(SYS_ioprio_set, 1 /* IOPRIO_WHO_PROCESS */);
        refuse_commands(SYS_fcntl, F_SETOWN, F_SETOWN_EX);
        refuse_commands(SYS_ioctl, FIOSETOWN, SIOCSPGRP);
    }
    emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
    struct sock_fprog filter = { .len = length, .filter = code };
    checked(prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &filter));
}

int main(int argc, char **argv) {
    const char *codex = getenv("BIRBCREW_NATIVE_BINARY");
    // Pi runs its SDK in a Node worker that loads Crew's code from this checkout and talks only to its host.
    const char *source = codex ? NULL : getenv("BIRBCREW_NATIVE_SOURCE");
    const int pi = source != NULL;
    if (!codex && argc < 3) return 126;
    pid_t parent = number(codex ? getenv("BIRBCREW_NATIVE_PARENT") : argv[1], INT_MAX);
    checked(prctl(PR_SET_PDEATHSIG, SIGKILL));
    if (getppid() != parent) return 126;
    char executable[PATH_MAX];
    if (!realpath(codex ? codex : argv[2], executable)) fail();
    int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < (codex ? 4 : 3)) return 126;
    uint64_t handled = (UINT64_C(1) << (abi >= 5 ? 16 : 15)) - 1;
    struct { uint64_t fs, net; } ruleset = { handled, codex ? 3 : 0 };
    int rules = syscall(SYS_landlock_create_ruleset, &ruleset, codex ? sizeof(ruleset) : sizeof(uint64_t), 0);
    checked(rules);
    uint64_t read = LANDLOCK_ACCESS_FS_READ_FILE, list = LANDLOCK_ACCESS_FS_READ_DIR;
    uint64_t write = LANDLOCK_ACCESS_FS_WRITE_FILE, exec = LANDLOCK_ACCESS_FS_EXECUTE;
    uint64_t private = read | list | write | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
        LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |
        LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE;
    permit(rules, executable, read | exec, 0);
    const char *readable[] = {"/etc/ld.so.cache","/etc/resolv.conf","/etc/hosts","/etc/nsswitch.conf","/etc/ssl/openssl.cnf",
        "/etc/gai.conf","/etc/localtime","/dev/random","/dev/urandom","/proc/meminfo","/proc/self/maps","/proc/self/stat",
        "/proc/self/status","/proc/self/statm","/proc/self/cgroup","/proc/sys/vm/overcommit_memory","/proc/sys/vm/mmap_min_addr",
        "/proc/cpuinfo","/proc/stat","/sys/devices/system/cpu/online",NULL};
    for (int i = 0; readable[i]; i++) permit(rules, readable[i], read, 1);
    permit(rules, "/etc/ssl/certs", read | list, 1);
    permit(rules, "/dev/null", read | write, 0);
    if (codex) {
        const char *home = getenv("CODEX_HOME"), *scratch = getenv("BIRBCREW_NATIVE_WORKSPACE");
        if (!home || !scratch) return 126;
        checked(chdir(scratch));
        permit(rules, home, private, 0);
        permit(rules, scratch, read | list, 0);
        port(rules, getenv("BIRBCREW_NATIVE_PROVIDER_PORT"));
        if (getenv("BIRBCREW_NATIVE_MCP_PORT")) port(rules, getenv("BIRBCREW_NATIVE_MCP_PORT"));
        unsetenv("BIRBCREW_NATIVE_BINARY"); unsetenv("BIRBCREW_NATIVE_PARENT"); unsetenv("BIRBCREW_NATIVE_WORKSPACE");
        unsetenv("BIRBCREW_NATIVE_PROVIDER_PORT"); unsetenv("BIRBCREW_NATIVE_MCP_PORT");
        argv[0] = executable;
    } else {
        const char *lib[] = {"/usr/lib","/usr/lib64","/lib64",NULL};
        for (int i = 0; lib[i]; i++) permit(rules, lib[i], read | list | exec, 1);
        permit(rules, ".", private, 0);
        if (source) {
            // Descriptor 3 is the worker's only route out; every other inherited descriptor closes below.
            struct stat channel;
            if (fstat(3, &channel) || !S_ISSOCK(channel.st_mode)) return 126;
            permit_under(rules, source, "package.json", read);
            permit_under(rules, source, "node_modules", read | list);
            permit_under(rules, source, "src/service", read | list);
            // npm's local dependency link resolves outside node_modules to compiled shared schemas.
            permit_under(rules, source, "packages/client/package.json", read);
            permit_under(rules, source, "packages/client/dist", read | list);
            unsetenv("BIRBCREW_NATIVE_SOURCE");
        }
        argv += 2;
    }
    checked(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0));
    install_filter(pi);
    checked(syscall(SYS_landlock_restrict_self, rules, 0));
    umask(0077);
    checked(syscall(SYS_close_range, pi ? 4 : 3, UINT_MAX, 0));
    execv(executable, argv);
    fail();
}
