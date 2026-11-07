(() => {
  function normalizeLoginRedirect(result) {
    if (result.response.type !== "opaqueredirect" &&
      !(result.response.status >= 300 && result.response.status < 400)) {
      return result;
    }
    return {
      response: new Response(null, { status: 401 }),
      parsedBody: {
        error: {
          code: "assistant_authentication_required",
          message: "Sign in again to use Athlete Assistant.",
          canRefresh: false,
        },
      },
    };
  }

  async function postQuestion(postJson, payload) {
    const send = async () => normalizeLoginRedirect(
      await postJson("/api/assistant/ask", payload, { redirect: "manual" }),
    );
    const result = await send();
    if (result.response.status !== 401 || result.parsedBody?.error?.canRefresh !== true) {
      return result;
    }
    const refreshed = await fetch("/.auth/refresh", {
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
    });
    return refreshed.ok ? send() : result;
  }

  globalThis.TriatwinAssistantSession = { postQuestion };
})();
