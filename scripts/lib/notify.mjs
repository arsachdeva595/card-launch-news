/**
 * Sends a Telegram message via the Bot API. No-ops (with a console warning)
 * if credentials aren't configured, and never throws — a notification
 * failure shouldn't fail the whole run.
 */
export async function notifyTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn("  ! TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set, skipping notification");
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
    if (!res.ok) {
      console.warn(`  ! Telegram notification failed (${res.status}): ${await res.text()}`);
    }
  } catch (err) {
    console.warn(`  ! Telegram notification error: ${err.message}`);
  }
}
