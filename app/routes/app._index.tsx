import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, HeadersFunction } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const reviews = await prisma.review.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });

  let settings = await prisma.storeSetting.findUnique({
    where: { shop },
  });

  if (!settings) {
    settings = await prisma.storeSetting.create({
      data: { shop, autoApproveReviews: true },
    });
  }

  return { reviews, settings };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "toggle_auto_approve") {
    const current = formData.get("current") === "true";
    await prisma.storeSetting.update({
      where: { shop },
      data: { autoApproveReviews: !current },
    });
    return { success: true, message: "Settings updated" };
  }

  if (actionType === "approve_review" || actionType === "unapprove_review") {
    const id = formData.get("id") as string;
    const status = actionType === "approve_review" ? "published" : "pending";
    await prisma.review.update({
      where: { id, shop },
      data: { status },
    });
    return { success: true, message: `Review ${status}` };
  }

  if (actionType === "delete_review") {
    const id = formData.get("id") as string;
    await prisma.review.delete({
      where: { id, shop },
    });
    return { success: true, message: "Review deleted" };
  }

  if (actionType === "add_review") {
    const title = formData.get("title") as string;
    const author = formData.get("author") as string;
    const rating = Number(formData.get("rating"));
    const body = formData.get("body") as string;
    const productId = formData.get("productId") as string;
    const status = formData.get("status") as string || "published";

    await prisma.review.create({
      data: {
        shop,
        productId,
        title,
        author,
        rating,
        body,
        status,
      },
    });
    return { success: true, message: "Review added" };
  }

  return { error: "Unknown action" };
};

export default function Index() {
  const { reviews, settings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  useEffect(() => {
    if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message);
    }
  }, [fetcher.data, shopify]);

  const toggleAutoApprove = () => {
    fetcher.submit(
      { actionType: "toggle_auto_approve", current: settings.autoApproveReviews.toString() },
      { method: "POST" }
    );
  };

  const updateReviewStatus = (id: string, approve: boolean) => {
    fetcher.submit(
      { actionType: approve ? "approve_review" : "unapprove_review", id },
      { method: "POST" }
    );
  };

  const deleteReview = (id: string) => {
    if (confirm("Are you sure you want to delete this review?")) {
      fetcher.submit({ actionType: "delete_review", id }, { method: "POST" });
    }
  };

  return (
    <s-page heading="Product Reviews">
      <s-button slot="primary-action" onClick={() => setIsAddModalOpen(true)}>
        Add New Review
      </s-button>

      <s-stack direction="block" gap="base">
        <s-section heading="Review Settings">
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="inline" gap="base">
              <s-text>Auto-Approve New Reviews:</s-text>
              <s-badge tone={settings.autoApproveReviews ? "success" : "critical"}>
                {settings.autoApproveReviews ? "Enabled" : "Disabled"}
              </s-badge>
              <s-button onClick={toggleAutoApprove} variant="secondary">
                Toggle Auto-Approve
              </s-button>
            </s-stack>
            <s-paragraph>
              <s-text tone="neutral">
                When enabled, reviews submitted by customers will instantly appear on your storefront. When disabled, they will be marked as "pending" until you approve them here.
              </s-text>
            </s-paragraph>
          </s-box>
        </s-section>

        <s-section heading="All Reviews">
          <s-box padding="none" borderWidth="base" borderRadius="base" background="subdued">
            <div style={{overflowX: 'auto', width: '100%'}}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '800px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #ebebeb' }}>
                  <th style={{ padding: '12px 16px', fontSize: '13px', color: '#5c5f62' }}>Date</th>
                  <th style={{ padding: '12px 16px', fontSize: '13px', color: '#5c5f62' }}>Rating</th>
                  <th style={{ padding: '12px 16px', fontSize: '13px', color: '#5c5f62' }}>Product ID</th>
                  <th style={{ padding: '12px 16px', fontSize: '13px', color: '#5c5f62' }}>Author</th>
                  <th style={{ padding: '12px 16px', fontSize: '13px', color: '#5c5f62' }}>Review</th>
                  <th style={{ padding: '12px 16px', fontSize: '13px', color: '#5c5f62' }}>Status</th>
                  <th style={{ padding: '12px 16px', fontSize: '13px', color: '#5c5f62', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {reviews.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: '24px', textAlign: 'center', color: '#5c5f62' }}>
                      No reviews found.
                    </td>
                  </tr>
                ) : (
                  reviews.map((review: any) => (
                    <tr key={review.id} style={{ borderBottom: '1px solid #ebebeb' }}>
                      <td style={{ padding: '12px 16px', fontSize: '14px' }}>
                        {new Date(review.createdAt).toLocaleDateString()}
                      </td>
                      <td style={{ padding: '12px 16px', fontSize: '14px', color: '#e5a500' }}>
                        {'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}
                      </td>
                      <td style={{ padding: '12px 16px', fontSize: '14px' }}>
                        {review.productId}
                      </td>
                      <td style={{ padding: '12px 16px', fontSize: '14px' }}>
                        <strong>{review.author || 'Anonymous'}</strong><br/>
                        <span style={{color: '#5c5f62', fontSize: '12px'}}>{review.email}</span>
                      </td>
                      <td style={{ padding: '12px 16px', fontSize: '14px', maxWidth: '300px' }}>
                        <strong>{review.title}</strong><br/>
                        <span style={{ color: '#5c5f62' }}>{review.body}</span>
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <s-badge tone={review.status === 'published' ? 'success' : 'warning'}>
                          {review.status}
                        </s-badge>
                      </td>
                      <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                        <s-stack direction="inline" gap="base">
                          {review.status === 'published' ? (
                            <button onClick={() => updateReviewStatus(review.id, false)} style={{background: 'none', border: '1px solid #d4d4d4', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', fontSize: '12px'}}>
                              Hide
                            </button>
                          ) : (
                            <button onClick={() => updateReviewStatus(review.id, true)} style={{background: '#008060', color: 'white', border: '1px solid #008060', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', fontSize: '12px'}}>
                              Approve
                            </button>
                          )}
                          <button onClick={() => deleteReview(review.id)} style={{background: 'none', color: '#d82c0d', border: '1px solid #d4d4d4', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', fontSize: '12px'}}>
                            Delete
                          </button>
                        </s-stack>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            </div>
          </s-box>
        </s-section>
      </s-stack>

      {/* Basic Add Review Modal using custom CSS/HTML over Shopify App Bridge for full control */}
      {isAddModalOpen && (
        <div style={{
          position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', 
          backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', 
          justifyContent: 'center', alignItems: 'center'
        }}>
          <div style={{
            background: 'white', padding: '24px', borderRadius: '8px', 
            width: '100%', maxWidth: '500px', maxHeight: '90vh', overflowY: 'auto'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '16px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: 'bold', margin: 0 }}>Add New Review</h2>
              <button onClick={() => setIsAddModalOpen(false)} style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer' }}>&times;</button>
            </div>
            
            <fetcher.Form method="post" onSubmit={() => setIsAddModalOpen(false)}>
              <input type="hidden" name="actionType" value="add_review" />
              
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', marginBottom: '4px', fontSize: '14px' }}>Product ID *</label>
                <input type="text" name="productId" required style={{ width: '100%', padding: '8px', border: '1px solid #c9cccf', borderRadius: '4px' }} placeholder="gid://shopify/Product/123456789" />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', marginBottom: '4px', fontSize: '14px' }}>Author Name *</label>
                <input type="text" name="author" required style={{ width: '100%', padding: '8px', border: '1px solid #c9cccf', borderRadius: '4px' }} />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', marginBottom: '4px', fontSize: '14px' }}>Rating *</label>
                <select name="rating" required style={{ width: '100%', padding: '8px', border: '1px solid #c9cccf', borderRadius: '4px' }}>
                  <option value="5">5 Stars</option>
                  <option value="4">4 Stars</option>
                  <option value="3">3 Stars</option>
                  <option value="2">2 Stars</option>
                  <option value="1">1 Star</option>
                </select>
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', marginBottom: '4px', fontSize: '14px' }}>Review Title *</label>
                <input type="text" name="title" required style={{ width: '100%', padding: '8px', border: '1px solid #c9cccf', borderRadius: '4px' }} />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', marginBottom: '4px', fontSize: '14px' }}>Review Body *</label>
                <textarea name="body" required rows={4} style={{ width: '100%', padding: '8px', border: '1px solid #c9cccf', borderRadius: '4px' }}></textarea>
              </div>

              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', marginBottom: '4px', fontSize: '14px' }}>Status</label>
                <select name="status" style={{ width: '100%', padding: '8px', border: '1px solid #c9cccf', borderRadius: '4px' }}>
                  <option value="published">Published (Approved)</option>
                  <option value="pending">Pending</option>
                </select>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button type="button" onClick={() => setIsAddModalOpen(false)} style={{ padding: '8px 16px', background: 'white', border: '1px solid #c9cccf', borderRadius: '4px', cursor: 'pointer' }}>Cancel</button>
                <button type="submit" style={{ padding: '8px 16px', background: '#008060', color: 'white', border: '1px solid #008060', borderRadius: '4px', cursor: 'pointer' }}>Add Review</button>
              </div>
            </fetcher.Form>
          </div>
        </div>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
