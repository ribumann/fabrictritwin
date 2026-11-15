"""Query a published Fabric data agent using the current Azure CLI identity."""

import argparse
import asyncio
import shutil
import subprocess
import sys
from datetime import timedelta
from uuid import UUID

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


async def query(workspace_id: UUID, agent_id: UUID, question: str, azure_cli: str) -> str:
    executable = shutil.which(azure_cli)
    if not executable:
        raise RuntimeError(f"Azure CLI executable not found: {azure_cli}")
    token = subprocess.check_output(
        [executable, "account", "get-access-token", "--resource", "https://api.fabric.microsoft.com",
         "--query", "accessToken", "-o", "tsv"],
        text=True,
    ).strip()
    if not token:
        raise RuntimeError("Azure CLI did not return a Fabric access token")
    url = f"https://api.fabric.microsoft.com/v1/mcp/workspaces/{workspace_id}/dataagents/{agent_id}/agent"
    async with streamablehttp_client(
        url, headers={"Authorization": f"Bearer {token}"},
        timeout=timedelta(seconds=30), sse_read_timeout=timedelta(seconds=300),
    ) as (read, write, _):
        async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=300)) as session:
            await session.initialize()
            tools = (await session.list_tools()).tools
            if len(tools) != 1:
                raise RuntimeError(f"Expected one data-agent tool, got {len(tools)}")
            properties = tools[0].inputSchema.get("properties", {})
            required = tools[0].inputSchema.get("required", [])
            if len(required) != 1 or required[0] not in properties:
                raise RuntimeError("Unexpected data-agent question schema")
            result = await session.call_tool(tools[0].name, {required[0]: question})
            text = "\n".join(block.text for block in result.content if block.type == "text")
            if result.isError:
                raise RuntimeError(f"Data agent returned an error: {text}")
            if not text:
                raise RuntimeError("Data agent returned no text")
            return text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=UUID, required=True)
    parser.add_argument("--agent", type=UUID, required=True)
    parser.add_argument("--azure-cli", default="az")
    parser.add_argument("question")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(asyncio.run(query(args.workspace, args.agent, args.question, args.azure_cli)))


if __name__ == "__main__":
    main()
