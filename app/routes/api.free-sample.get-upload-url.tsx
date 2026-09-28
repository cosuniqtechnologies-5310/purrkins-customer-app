import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin } = await authenticate.public.appProxy(request);
    if (!admin) {
      return Response.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const formData = await request.formData();
    const filename = formData.get("filename") as string;
    const mimeType = formData.get("mimeType") as string;

    const stagedResponse = await admin.graphql(
      `#graphql
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          input: [{
            filename: filename || "profile_image.jpg",
            mimeType: mimeType || "image/jpeg",
            resource: "IMAGE",
            httpMethod: "POST"
          }]
        }
      }
    );

    const stagedData = await stagedResponse.json();
    const target = stagedData.data?.stagedUploadsCreate?.stagedTargets?.[0];

    if (!target) {
      return Response.json({ success: false, message: "Failed to generate upload URL" }, { status: 400 });
    }

    return Response.json({ success: true, target });
  } catch (err: any) {
    return Response.json({ success: false, message: err.message }, { status: 500 });
  }
};
