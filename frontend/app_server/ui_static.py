"""Static mount for the UI asset tree.

The UI is one large ES-module graph: a page imports modules that import more
modules, and every edge is resolved by URL. ``StaticFiles`` answers with
``etag`` and ``last-modified`` but no ``cache-control``, which leaves the
browser on heuristic freshness -- it may reuse a cached module for hours
without ever asking whether the file changed.

That turns an ordinary edit into a broken page. When a module gains an export
and its importer is re-fetched while the module itself is served from cache,
the two copies disagree and module linking fails outright with
"does not provide an export named ...". Per-import ``?v=`` query stamps only
paper over this: they have to be bumped in every importer of a changed file,
and a file nobody stamps can never be invalidated at all.

``no-cache`` keeps the responses cacheable but requires a revalidation before
each reuse, so the browser can only serve a module the server has just
confirmed is current. Over loopback an unchanged file costs one 304.
"""
from __future__ import annotations

from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope


class RevalidatedStaticFiles(StaticFiles):
    """``StaticFiles`` that makes the browser revalidate before reusing a file."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        response.headers["cache-control"] = "no-cache"
        return response
