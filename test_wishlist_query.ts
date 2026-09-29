import shopify from './app/shopify.server';

async function test() {
  const { admin } = await shopify.unauthenticated.admin("purrkins-mhrlfymw.myshopify.com");
  
  const customerId = "gid://shopify/Customer/10673120641271";
  
  const response = await admin.graphql(`
    query {
      customer(id: "${customerId}") {
        firstName
        wishlist: metafield(namespace: "custom", key: "wishlist") {
          value
          type
          references(first: 10) {
            nodes {
              ... on Product {
                title
              }
            }
          }
        }
      }
    }
  `);
  
  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

test();
