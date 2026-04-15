#!/usr/bin/env python3
"""
Rotman AV Booking - Email Sender via SMTP
Simple SMTP email sender using smtplib
"""

import os
import sys
try:
    from email.mime.html import MIMEHtml
except ImportError:
    MIMEHtml = None

from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart


def send_email_smtp(
    to_email: str,
    subject: str,
    body_html: str = "",
    body_text: str = "",
    to_name: str = ""
) -> bool:
    """
    Send email via SMTP (Office 365 / Outlook)
    
    Args:
        to_email: Recipient email address
        subject: Email subject
        body_html: Email body in HTML format
        body_text: Email body in plain text
        to_name: Recipient display name
    
    Returns:
        True if sent successfully, False otherwise
    """
    # SMTP settings from environment
    smtp_host = os.getenv("SMTP_HOST", "smtp.office365.com")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_user = os.getenv("SMTP_USERNAME", "")
    smtp_pass = os.getenv("SMTP_PASSWORD", "")
    from_email = os.getenv("SMTP_FROM", smtp_user)
    from_name = os.getenv("SMTP_FROM_NAME", "Rotman AV Booking")
    
    # Override with explicit creds if provided
    if not smtp_user and os.getenv("OUTLOOK_USERNAME"):
        smtp_user = os.getenv("OUTLOOK_USERNAME")
    if not smtp_pass and os.getenv("OUTLOOK_PASSWORD"):
        smtp_pass = os.getenv("OUTLOOK_PASSWORD")
    
    if not smtp_user or not smtp_pass:
        print("ERROR: SMTP_USERNAME and SMTP_PASSWORD environment variables required")
        print("Set OUTLOOK_USERNAME and OUTLOOK_PASSWORD as alternative")
        return False
    
    if not to_email:
        to_email = os.getenv("EMAIL_TO", "")
        if not to_email:
            print("ERROR: Recipient email (to_email or EMAIL_TO) is required")
            return False
    
    if not subject:
        subject = "Rotman AV Booking Request"
    
    try:
        print(f"Connecting to SMTP server {smtp_host}:{smtp_port}...")
        
        # Import smtplib
        import smtplib
        
        # Create message
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f"{from_name} <{from_email}>"
        msg["To"] = to_email
        
        # Add plain text version
        if body_text:
            text_part = MIMEText(body_text, "plain")
            msg.attach(text_part)
        elif body_html:
            # Generate plain text from HTML
            import re
            clean = re.compile('<.*?>')
            text_content = re.sub(clean, '', body_html)
            text_part = MIMEText(text_content, "plain")
            msg.attach(text_part)
        
        # Add HTML version
        if body_html and MIMEHtml:
            html_part = MIMEHtml(body_html)
            msg.attach(html_part)
        
        # Connect and send
        if smtp_port == 465:
            # SSL connection
            server = smtplib.SMTP_SSL(smtp_host, smtp_port)
            server.ehlo()
        else:
            # TLS connection
            server = smtplib.SMTP(smtp_host, smtp_port)
            server.ehlo()
            server.starttls()
            server.ehlo()
        
        print(f"Logging in as {smtp_user}...")
        server.login(smtp_user, smtp_pass)
        
        print(f"Sending email to {to_email}...")
        server.sendmail(from_email, [to_email], msg.as_string())
        
        server.quit()
        
        print("✓ Email sent successfully!")
        return True
        
    except Exception as e:
        print(f"✗ Failed to send email: {e}")
        return False


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Send email via SMTP")
    parser.add_argument("--to", required=True, help="Recipient email address")
    parser.add_argument("--name", default="", help="Recipient name")
    parser.add_argument("--subject", required=True, help="Email subject")
    parser.add_argument("--body", default="", help="Email body (plain text or HTML)")
    parser.add_argument("--html", action="store_true", help="Body contains HTML")
    
    args = parser.parse_args()
    
    body_html = args.body if args.html else ""
    body_text = args.body if not args.html else ""
    
    success = send_email_smtp(
        to_email=args.to,
        subject=args.subject,
        body_html=body_html,
        body_text=body_text,
        to_name=args.name
    )
    
    sys.exit(0 if success else 1)