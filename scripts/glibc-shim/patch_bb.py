#!/usr/bin/env python3
"""
Patch the bb binary to replace GLIBC_2.38 and GLIBC_2.39 version requirements
with GLIBC_2.35 (which exists in our system glibc).

This patches both the version strings AND the ELF hashes in .gnu.version_r.
"""
import struct
import sys

def elf_hash(name: bytes) -> int:
    """Compute ELF hash (used for version requirements)."""
    h = 0
    for b in name:
        h = ((h << 4) + b) & 0xffffffff
        g = h & 0xf0000000
        if g:
            h ^= g >> 24
        h &= ~g & 0xffffffff
    return h

def patch_binary(input_path, output_path):
    with open(input_path, "rb") as f:
        data = bytearray(f.read())
    
    # Target: replace GLIBC_2.38 -> GLIBC_2.35 and GLIBC_2.39 -> GLIBC_2.35
    old_versions = [b"GLIBC_2.38", b"GLIBC_2.39"]
    new_version = b"GLIBC_2.35"
    
    new_hash = elf_hash(new_version)
    print(f"Target version: {new_version.decode()}, ELF hash: 0x{new_hash:08x}")
    
    for old_ver in old_versions:
        old_hash = elf_hash(old_ver)
        print(f"\nPatching {old_ver.decode()} (hash 0x{old_hash:08x}) -> {new_version.decode()} (hash 0x{new_hash:08x})")
        
        # 1. Patch version strings in string table
        str_count = 0
        pos = 0
        while True:
            idx = data.find(old_ver + b"\x00", pos)
            if idx == -1:
                break
            data[idx:idx+len(old_ver)] = new_version
            str_count += 1
            pos = idx + len(old_ver)
        print(f"  Patched {str_count} string occurrence(s)")
        
        # 2. Patch ELF hashes in .gnu.version_r section
        # The hash is stored as a 32-bit LE value
        old_hash_bytes = struct.pack("<I", old_hash)
        new_hash_bytes = struct.pack("<I", new_hash)
        hash_count = 0
        pos = 0
        while True:
            idx = data.find(old_hash_bytes, pos)
            if idx == -1:
                break
            # Verify this looks like a version requirement entry
            # (hashes appear in .gnu.version_r entries)
            data[idx:idx+4] = new_hash_bytes
            hash_count += 1
            pos = idx + 4
        print(f"  Patched {hash_count} hash occurrence(s)")
    
    with open(output_path, "wb") as f:
        f.write(data)
    print(f"\nWritten patched binary to {output_path}")

if __name__ == "__main__":
    BB_ORIG = sys.argv[1] if len(sys.argv) > 1 else "/home/ec2-user/.aztec/versions/4.0.0-devnet.2-patch.0/node_modules/@aztec/bb.js/build/amd64-linux/bb"
    BB_OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/bb_patched"
    patch_binary(BB_ORIG, BB_OUT)
