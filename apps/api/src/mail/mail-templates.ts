import type { OutgoingMail } from "./mail.service";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#1b1f24">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px">
<h2 style="margin:0 0 16px;font-size:20px">${escapeHtml(title)}</h2>${bodyHtml}
<p style="margin:24px 0 0;font-size:12px;color:#6b7280">RegOps &middot; AML/CFT compliance platform</p>
</div></body></html>`;
}

function button(url: string, label: string): string {
  return `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block">${escapeHtml(label)}</a></p>
<p style="font-size:12px;color:#6b7280;word-break:break-all">If the button does not work, copy this link into your browser:<br>${escapeHtml(url)}</p>`;
}

export function inviteMail(params: { to: string; fullName: string; inviterName: string; tenantName: string; url: string; expiresInDays: number }): OutgoingMail {
  const { to, fullName, inviterName, tenantName, url, expiresInDays } = params;
  return {
    to,
    subject: `You've been invited to RegOps (${tenantName})`,
    text: `Hello ${fullName},\n\n${inviterName} invited you to join ${tenantName} on RegOps.\nSet your password to activate your account (link valid for ${expiresInDays} days):\n\n${url}\n\nIf you did not expect this invitation, ignore this email.`,
    html: layout(
      "You're invited to RegOps",
      `<p>Hello ${escapeHtml(fullName)},</p><p>${escapeHtml(inviterName)} invited you to join <strong>${escapeHtml(tenantName)}</strong> on RegOps.</p>
<p>Set your password to activate your account. The link is valid for ${expiresInDays} days.</p>${button(url, "Set your password")}
<p style="font-size:13px;color:#6b7280">If you did not expect this invitation, you can ignore this email.</p>`,
    ),
  };
}

export function passwordResetMail(params: { to: string; fullName: string; url: string; expiresInMinutes: number }): OutgoingMail {
  const { to, fullName, url, expiresInMinutes } = params;
  return {
    to,
    subject: "Reset your RegOps password",
    text: `Hello ${fullName},\n\nWe received a request to reset your RegOps password. Use this link within ${expiresInMinutes} minutes:\n\n${url}\n\nIf you did not ask for this, ignore this email; your password stays unchanged.`,
    html: layout(
      "Reset your password",
      `<p>Hello ${escapeHtml(fullName)},</p><p>We received a request to reset your RegOps password. The link is valid for ${expiresInMinutes} minutes.</p>${button(url, "Choose a new password")}
<p style="font-size:13px;color:#6b7280">If you did not ask for this, ignore this email; your password stays unchanged.</p>`,
    ),
  };
}

export function passwordChangedMail(params: { to: string; fullName: string }): OutgoingMail {
  const { to, fullName } = params;
  return {
    to,
    subject: "Your RegOps password was changed",
    text: `Hello ${fullName},\n\nYour RegOps password was just changed and all your sessions were signed out. If this was not you, reset your password immediately and contact your administrator.`,
    html: layout(
      "Your password was changed",
      `<p>Hello ${escapeHtml(fullName)},</p><p>Your RegOps password was just changed and all of your sessions were signed out.</p>
<p>If this was not you, reset your password immediately and contact your administrator.</p>`,
    ),
  };
}
