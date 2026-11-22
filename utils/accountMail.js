// "Your account is ready" email sent when an admin creates an admin / staff account.
// Contains the login email and the password the admin set, plus a link to the login page.
const transporter = require("./mailer");
const mail = require("./mailLayout");

const loginUrl = () => `${(process.env.PUBLIC_URL || process.env.FRONTEND_URL || "https://ifrutico.com").replace(/\/+$/, "")}/login`;
const ROLE = { admin: "Admin", staff: "Staff" };

// Throws if the mail can't be sent (caller decides what to tell the admin)
const sendAccountCredentials = async (user, password) => {
  const M = mail.P;
  const url = loginUrl();
  const role = ROLE[user.role] || "Staff";
  const article = role === "Admin" ? "An admin" : "A staff";
  const body = `
    <tr><td class="px" style="padding:34px 40px 6px;">
      ${mail.eyebrow("Account created")}
      ${mail.heading(`Welcome, ${user.name}`, 24)}
      <p style="margin:10px 0 0;font-size:15px;line-height:1.7;color:${M.soft};">${article} account has been created for you on the Ifrutico dashboard. Use the details below to sign in.</p>
    </td></tr>
    <tr><td class="px" style="padding:22px 40px 0;">
      ${mail.infoPanel([
        ["Login email", mail.esc(user.email)],
        ["Password", `<span style="font-family:Consolas,Menlo,monospace;letter-spacing:.5px;">${mail.esc(password)}</span>`],
        ["Role", mail.esc(role)],
      ])}
    </td></tr>
    <tr><td class="px" align="center" style="padding:6px 40px 0;">
      ${mail.button("Sign in to the dashboard", url)}
    </td></tr>
    <tr><td class="px" style="padding:14px 40px 34px;">
      <p style="margin:0;font-size:13px;line-height:1.7;color:${M.faint};">For your security, change this password after your first sign-in using <strong>Forgot password</strong> on the login page. Never share it with anyone. A one-time code will also be emailed to you each time you sign in.</p>
    </td></tr>`;

  await transporter.sendMail({
    from: process.env.MAIL_USER,
    to: user.email,
    subject: "Your Ifrutico dashboard account",
    text: [
      `Welcome, ${user.name}!`,
      `${article} account has been created for you on the Ifrutico dashboard.`,
      "",
      `Login email: ${user.email}`,
      `Password: ${password}`,
      `Role: ${role}`,
      "",
      `Sign in: ${url}`,
      "",
      "Change this password after your first sign-in using 'Forgot password' on the login page. Never share it with anyone.",
    ].join("\n"),
    html: mail.layout({
      title: "Your Ifrutico account",
      preheader: "Your Ifrutico dashboard login details",
      body,
      logoSrc: mail.hasLogo() ? `cid:${mail.LOGO_CID}` : null,
      footerNote: "You received this because an Ifrutico admin created an account for you. If this wasn't expected, contact your admin.",
    }),
    attachments: mail.logoAttachment(),
  });
};

module.exports = { sendAccountCredentials };
