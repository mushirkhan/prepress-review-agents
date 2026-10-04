# The external MCP filesystem server (@modelcontextprotocol/server-filesystem,
# maintained by the MCP project, not by this repo), exposed over Streamable
# HTTP on the internal Docker network by supergateway (stdio -> HTTP bridge).
#
# One image, two containers (see infra/compose.yml): each is started with the
# single folder it may see, and that folder is mounted read-only or
# read-write as its job requires.
FROM node:22-alpine

RUN npm install -g --no-audit --no-fund \
      @modelcontextprotocol/server-filesystem@2026.8.31 \
      supergateway@4.1.0 \
  && npm cache clean --force

USER node
EXPOSE 8000

ENTRYPOINT ["supergateway", "--outputTransport", "streamableHttp", "--stateful", \
            "--port", "8000", "--streamableHttpPath", "/mcp", \
            "--healthEndpoint", "/healthz", "--logLevel", "info", "--stdio"]
# Overridden per container with the folder it may see.
CMD ["mcp-server-filesystem /data"]
