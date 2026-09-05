# Extract Minecraft Source Code
The `minecraft_source_extractor` tool downloads Minecraft JARs from Mojang, de-obfuscates (for 1.x) or decompiles (for 26.x) using Fabric Loom's `genSources` task (Vineflower decompiler), and extracts the full Java source tree to `/home/agent/minecraft_source/{version}`.

## Usage
```bash
/home/agent/scripts/minecraft_source_extractor --version 1.21.4
/home/agent/scripts/minecraft_source_extractor --version 26.2
```

## Custom Output Directory
By default sources land in `/home/agent/minecraft_source/{version}`. Use `--output-dir` to change the parent directory:
```bash
/home/agent/scripts/minecraft_source_extractor --version 1.20.1 --output-dir /custom/path
```

## Listing Supported Versions
```bash
/home/agent/scripts/minecraft_source_extractor --list-versions
```

## Key Options
| Option            | Description                                                                      |
|-------------------|----------------------------------------------------------------------------------|
| `--version`       | Minecraft full release version (e.g. 1.21.4, 26.2)                               |
| `--output-dir`    | Parent directory for extracted sources (default: `/home/agent/minecraft_source`) |
| `--list-versions` | List all supported Minecraft versions and exit                                   |

## Supported Versions
Minecraft full releases from **1.20.0** through **26.2**.

## Workflow
1. A temporary Fabric Loom Gradle project is generated.
2. `./gradlew genSources` downloads the client + server JARs from Mojang.
   - **1.x**: merges JARs, remaps bytecode with official Mojang mappings, and decompiles with Vineflower.
   - **26.x**: Minecraft is not obfuscated. Loom merges JARs and decompiles directly (no mapping step needed).
3. Decompiled `.java` files are extracted from the Loom cache to the target directory.
4. The temporary project is removed (kept on failure for debugging).

## Notes
- Requires a suitable JDK on PATH:
  - **1.20 – 1.20.4**: JDK 17
  - **1.20.5 – 1.21.11**: JDK 21
  - **26.x**: JDK 25
- First run per version may take 5–15 minutes (~200–400 MB download). Subsequent runs are fast due to Gradle/Loom caching.
- The output directory is not cleaned before extraction — existing `.java` files will be overwritten.