import { prisma } from "../src/lib/prisma";

async function main() {
  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      localPhotoDirectory: true,
      cameraName: true,
      cameraDevice: true,
    },
  });

  if (projects.length === 0) {
    console.log("No projects found.");
    return;
  }

  for (const project of projects) {
    const camera = project.cameraDevice
      ? `${project.cameraName ?? "Camera"} (${project.cameraDevice})`
      : "No camera selected";
    console.log(`${project.id}\t${project.name}\t${camera}\t${project.localPhotoDirectory}`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
