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

await run("pnpm", ["exec", "next", "build"], {
  ...process.env,
  PLANTLAB_TEST_LOCAL_CAMERA_UI: "1",
});

const child = spawn("pnpm", ["exec", "next", "start", "--hostname", "127.0.0.1", "--port", port], {
  stdio: "inherit",
  shell: false,
  env: {
    ...process.env,
    NODE_ENV: "development",
    PLANTLAB_TEST_LOCAL_CAMERA_UI: "1",
  },
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
