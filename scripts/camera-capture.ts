import { captureProjectPhoto } from "../src/lib/camera";
import { prisma } from "../src/lib/prisma";

async function main() {
  const projectId = process.argv.slice(2).find((argument) => argument !== "--");

  if (!projectId) {
    throw new Error("Usage: pnpm camera:capture -- <project-id>");
  }

  const result = await captureProjectPhoto(projectId);
  console.log(`Captured photo: ${result.savedPath}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
