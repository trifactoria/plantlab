import { spawn } from "node:child_process";

const port = process.env.PORT ?? "3000";

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      env,
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} exited with ${signal}`));
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

// The support-bundle fixture screenshot run sets PLANTLAB_SKIP_BUILD=1 and
// starts a `next dev` server instead of build+start: it needs no prior build
// (the slow step) and `next dev` starts reliably, whereas `next start` with a
// NODE_ENV=development override against a production .next can fail to become
// ready in some environments. The default (CI/local) path keeps build+start.
const skipBuild = process.env.PLANTLAB_SKIP_BUILD === "1";

if (!skipBuild) {
  await run("pnpm", ["exec", "next", "build"], {
    ...process.env,
    PLANTLAB_TEST_LOCAL_CAMERA_UI: "1",
  });
}

const child = skipBuild
  ? spawn("pnpm", ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", port], {
      stdio: "inherit",
      shell: false,
      env: { ...process.env, PLANTLAB_TEST_LOCAL_CAMERA_UI: "1" },
    })
  : spawn("pnpm", ["exec", "next", "start", "--hostname", "127.0.0.1", "--port", port], {
      stdio: "inherit",
      shell: false,
      env: { ...process.env, NODE_ENV: "development", PLANTLAB_TEST_LOCAL_CAMERA_UI: "1" },
    });

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
