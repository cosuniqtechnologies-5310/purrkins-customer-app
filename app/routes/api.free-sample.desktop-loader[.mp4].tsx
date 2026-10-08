import type { LoaderFunctionArgs } from "react-router";
import * as fs from "fs";
import * as path from "path";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const videoPath = path.resolve(process.cwd(), "public", "desktop-loader.mp4");

  try {
    const stat = fs.statSync(videoPath);
    const range = request.headers.get("range");

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;
      const buffer = Buffer.alloc(chunkSize);
      const fd = fs.openSync(videoPath, "r");
      fs.readSync(fd, buffer, 0, chunkSize, start);
      fs.closeSync(fd);

      return new Response(buffer, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize.toString(),
          "Content-Type": "video/mp4",
          "Cache-Control": "public, max-age=31536000",
        },
      });
    }

    const file = fs.readFileSync(videoPath);
    return new Response(file, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": stat.size.toString(),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000",
      },
    });
  } catch (error) {
    return new Response("Not found", { status: 404 });
  }
};
