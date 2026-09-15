import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  ensureEnvFiles,
  ensureLocalCamoufoxRuntime,
  repoRoot,
  runCommand,
  runCommandCapture,
} from "./lib/runtime.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const CAMOUFOX_LAUNCH_PATH_SCRIPT = [
  "from camoufox.pkgman import launch_path",
  "print(launch_path())",
].join("; ");

const CAMOUFOX_REPAIR_SCRIPT = [
  "from camoufox.pkgman import CamoufoxFetcher, launch_path",
  "fetcher = CamoufoxFetcher()",
  "fetcher.fetch_latest()",
  "fetcher.install(replace=True)",
  "print(launch_path())",
].join("; ");

function cleanLastLine(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) || "";
}

async function resolveLaunchPath(pythonBin) {
  const { stdout } = await runCommandCapture(pythonBin, ["-c", CAMOUFOX_LAUNCH_PATH_SCRIPT]);
  const launchPath = cleanLastLine(stdout);
  if (!launchPath || !fs.existsSync(launchPath)) {
    throw new Error(`Camoufox launch path is missing: ${launchPath || "<empty>"}`);
  }
  return launchPath;
}

async function ensureUsableCamoufoxExecutable(pythonBin) {
  const configured = process.env.CAMOUFOX_EXECUTABLE_PATH?.trim();
  if (configured && fs.existsSync(configured)) {
    return configured;
  }

  try {
    return await resolveLaunchPath(pythonBin);
  } catch (firstError) {
    console.log("Camoufox metadata says the browser is installed, but its executable is missing. Repairing the active browser install...");
    try {
      await runCommand(pythonBin, ["-c", CAMOUFOX_REPAIR_SCRIPT]);
      return await resolveLaunchPath(pythonBin);
    } catch (repairError) {
      const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
      const repairMessage = repairError instanceof Error ? repairError.message : String(repairError);
      throw new Error(
        `Camoufox executable is still unavailable after a forced reinstall. Initial check: ${firstMessage}. Repair: ${repairMessage}. ` +
          "If Windows Security or corporate endpoint protection quarantined camoufox.exe, the local Camoufox path cannot run on this machine without an allowed binary.",
      );
    }
  }
}

async function main() {
  const targetArg = process.argv[2];
  if (!targetArg) {
    throw new Error("Missing target script. Usage: node scripts/run-with-camoufox-runtime.mjs <target-script> [...args]");
  }

  const targetPath = path.resolve(repoRoot, targetArg);
  if (!targetPath.startsWith(`${repoRoot}${path.sep}`) || !fs.existsSync(targetPath)) {
    throw new Error(`Invalid target script: ${targetArg}`);
  }

  await ensureEnvFiles();
  const pythonBin = await ensureLocalCamoufoxRuntime();
  const executablePath = await ensureUsableCamoufoxExecutable(pythonBin);
  process.env.CAMOUFOX_EXECUTABLE_PATH = executablePath;
  console.log(`Camoufox executable verified: ${executablePath}`);

  const forwardedArgs = process.argv.slice(3);
  await runCommand(process.execPath, [targetPath, ...forwardedArgs], {
    cwd: repoRoot,
    env: process.env,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
