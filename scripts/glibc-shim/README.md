# GLIBC Compatibility Shim for Barretenberg (bb)

The `bb` binary shipped with `@aztec/bb.js` requires GLIBC 2.38/2.39, which
is not available on Amazon Linux 2023 (GLIBC 2.34). This shim provides the
6 missing symbols as wrappers around existing glibc functions.

## Missing Symbols

| Symbol | GLIBC | Shim Implementation |
|--------|-------|-------------------|
| `__isoc23_strtol` | 2.38 | Wraps `strtol` (identical behavior) |
| `__isoc23_strtoul` | 2.38 | Wraps `strtoul` |
| `__isoc23_strtoll` | 2.38 | Wraps `strtoll` |
| `__isoc23_strtoull` | 2.38 | Wraps `strtoull` |
| `pidfd_spawnp` | 2.39 | Returns -ENOSYS (weak, rarely called) |
| `pidfd_getpid` | 2.39 | Returns -ENOSYS (weak, rarely called) |

## How to Rebuild

```bash
# 1. Compile the shim library
gcc -shared -fPIC -Wl,--version-script=glibc_shim_versions.map \
    -o ../../glibc_shim.so glibc_shim.c

# 2. Patch the bb binary
python3 patch_bb.py \
    ~/.aztec/versions/4.0.0-devnet.2-patch.0/node_modules/@aztec/bb.js/build/amd64-linux/bb \
    ../../bb_patched
chmod +x ../../bb_patched

# 3. Use it
BB=../../bb_wrapper.sh aztec compile
```
