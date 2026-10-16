import type { LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const session = url.searchParams.get("session") || "";

  return new Response(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <script>
          var s = new URL(window.location.href).searchParams.get('session') || localStorage.getItem('pk_session');
          var dest = '/apps/purrkins/dashboard' + (s ? ('?session=' + encodeURIComponent(s)) : '') + '#kitten';
          window.location.replace(dest);
        </script>
      </head>
      <body></body>
    </html>
  `, {
    headers: {
      "Content-Type": "application/liquid",
      "Cache-Control": "no-store, no-cache, must-revalidate"
    }
  });
};
