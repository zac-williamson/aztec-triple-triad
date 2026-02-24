/*
 * GLIBC compatibility shim for bb (Barretenberg) binary.
 * 
 * The bb binary was compiled against GLIBC 2.38/2.39 which introduced:
 * - __isoc23_strtol/strtoul/strtoll/strtoull (C23 string-to-int functions)
 * - pidfd_spawnp / pidfd_getpid (process fd operations)
 * 
 * The __isoc23_strto* functions are functionally identical to the classic strto* 
 * functions for all practical purposes (C23 made the base=0 behavior slightly 
 * more defined, but the actual implementation is the same).
 *
 * The pidfd_* functions are weak symbols so may not be needed, but we provide
 * stubs that return -ENOSYS just in case.
 * 
 * Compile: gcc -shared -fPIC -o glibc_shim.so glibc_shim.c
 * Usage:   LD_PRELOAD=./glibc_shim.so bb aztec_process
 */

#include <stdlib.h>
#include <errno.h>

/* C23 strto* functions — identical to C99/C11 versions */
long __isoc23_strtol(const char *nptr, char **endptr, int base) {
    return strtol(nptr, endptr, base);
}

unsigned long __isoc23_strtoul(const char *nptr, char **endptr, int base) {
    return strtoul(nptr, endptr, base);
}

long long __isoc23_strtoll(const char *nptr, char **endptr, int base) {
    return strtoll(nptr, endptr, base);
}

unsigned long long __isoc23_strtoull(const char *nptr, char **endptr, int base) {
    return strtoull(nptr, endptr, base);
}

/* pidfd_spawnp and pidfd_getpid — stub implementations */
/* These are weak symbols in bb, so they may never be called */
int pidfd_spawnp(int *pidfd, const char *file, 
                 const void *file_actions, const void *attrp,
                 char *const argv[], char *const envp[]) {
    errno = ENOSYS;
    return -1;
}

int pidfd_getpid(int pidfd) {
    errno = ENOSYS;
    return -1;
}
