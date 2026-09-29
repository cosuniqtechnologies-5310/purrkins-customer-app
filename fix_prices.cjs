const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const session = await prisma.session.findFirst({ where: { shop: 'purrkins-mhrlfymw.myshopify.com', isOnline: false } });
  
  const query = `
    mutation {
      productUpdate1: productUpdate(input: { id: "gid://shopify/Product/10097392943351", variants: [{ id: "gid://shopify/ProductVariant/44503700078839", price: "90.00" }] }) {
        product { id title variants(first:1) { edges { node { price } } } }
      }
      productUpdate2: productUpdate(input: { id: "gid://shopify/Product/10097353162999", variants: [{ id: "gid://shopify/ProductVariant/44503612883191", price: "90.00" }] }) {
        product { id title variants(first:1) { edges { node { price } } } }
      }
    }
  `;

  // First fetch the variant IDs
  const vQuery = `
    query {
      p1: product(id: "gid://shopify/Product/10097392943351") { variants(first: 1) { edges { node { id } } } }
      p2: product(id: "gid://shopify/Product/10097353162999") { variants(first: 1) { edges { node { id } } } }
    }
  `;

  const vRes = await fetch('https://purrkins-mhrlfymw.myshopify.com/admin/api/2026-07/graphql.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': session.accessToken },
    body: JSON.stringify({ query: vQuery })
  });

  const vData = await vRes.json();
  const v1 = vData.data.p1.variants.edges[0].node.id;
  const v2 = vData.data.p2.variants.edges[0].node.id;

  const mutQuery = `
    mutation {
      productUpdate1: productVariantUpdate(input: { id: "${v1}", price: "90.00" }) {
        productVariant { id price }
      }
      productUpdate2: productVariantUpdate(input: { id: "${v2}", price: "90.00" }) {
        productVariant { id price }
      }
    }
  `;

  const response = await fetch('https://purrkins-mhrlfymw.myshopify.com/admin/api/2026-07/graphql.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': session.accessToken },
    body: JSON.stringify({ query: mutQuery })
  });

  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

run();
