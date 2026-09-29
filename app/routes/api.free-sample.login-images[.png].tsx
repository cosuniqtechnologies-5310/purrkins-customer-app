import type { LoaderFunctionArgs } from "react-router";
import * as fs from "fs";
import * as path from "path";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const imagePath = path.resolve(process.cwd(), "public", "login-images.png");
  
  try {
    const file = fs.readFileSync(imagePath);
    return new Response(file, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=31536000",
      },
    });
  } catch (error) {
    return new Response("Not found", { status: 404 });
  }
};
