import nodemailer from "nodemailer";

export class EmailNotifier {
  constructor(database, logger) {
    this.database = database;
    this.logger = logger;
    this.cachedSignature = null;
    this.transporter = null;
  }

  buildSignature(config) {
    return JSON.stringify({
      enabled: config.enabled,
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort,
      smtpSecure: config.smtpSecure,
      smtpUser: config.smtpUser,
      smtpPass: config.smtpPass,
      fromAddress: config.fromAddress,
      toAddresses: config.toAddresses
    });
  }

  getTransporter() {
    const config = this.database.getEmailSettings(true);
    if (!config.enabled) {
      return { transporter: null, config, reason: "email notifications disabled" };
    }

    if (!config.smtpHost || !config.smtpUser || !config.smtpPass || !config.fromAddress || config.toAddresses.length === 0) {
      return { transporter: null, config, reason: "SMTP settings incomplete" };
    }

    const signature = this.buildSignature(config);
    if (!this.transporter || this.cachedSignature !== signature) {
      this.cachedSignature = signature;
      this.transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: Number(config.smtpPort ?? 587),
        secure: Boolean(config.smtpSecure),
        auth: {
          user: config.smtpUser,
          pass: config.smtpPass
        }
      });
    }

    return { transporter: this.transporter, config, reason: null };
  }

  async send(subject, text) {
    const { transporter, config, reason } = this.getTransporter();
    if (!transporter) {
      this.logger.warn("Skipping email notification", {
        reason,
        subject
      });
      return;
    }

    await transporter.sendMail({
      from: config.fromAddress,
      to: config.toAddresses.join(", "),
      subject,
      text
    });
  }
}
