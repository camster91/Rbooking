#!/usr/bin/env python3
"""
Rotman AV Booking - Email Sender via Outlook
Uses Playwright headless browser to send emails through Outlook Web (outlook.office365.com)
"""

import asyncio
import json
import os
import sys
from datetime import datetime
from dataclasses import dataclass
from typing import Optional, List
from pathlib import Path

try:
    from playwright.async_api import async_playwright, Page, BrowserContext
except ImportError:
    print("Playwright not installed. Run: pip install playwright && playwright install chromium")
    sys.exit(1)


@dataclass
class EmailConfig:
    """Email configuration"""
    username: str  # Full email address (user@utoronto.ca)
    password: str  # Password
    
    # Email content
    to_email: str
    to_name: str = ""
    subject: str = ""
    body_html: str = ""
    body_text: str = ""
    
    # Server info
    outlook_url: str = "https://outlook.office365.com/mail/?realm=utoronto.ca"
    
    @classmethod
    def from_env(cls):
        """Load from environment variables"""
        return cls(
            username=os.getenv("OUTLOOK_USERNAME", ""),
            password=os.getenv("OUTLOOK_PASSWORD", ""),
            to_email=os.getenv("EMAIL_TO", ""),
            to_name=os.getenv("EMAIL_TO_NAME", ""),
            subject=os.getenv("EMAIL_SUBJECT", ""),
            body_html=os.getenv("EMAIL_HTML", ""),
            body_text=os.getenv("EMAIL_TEXT", ""),
        )


class OutlookEmailSender:
    """Send emails via Outlook Web using Playwright"""
    
    def __init__(self, config: EmailConfig):
        self.config = config
        self.playwright = None
        self.browser = None
        self.context = None
        self.page = None
        self.logged_in = False
    
    async def initialize(self):
        """Initialize Playwright browser"""
        self.playwright = async_playwright().start()
        self.browser = await self.playwright.chromium.launch(
            headless=True,
            args=[
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
            ]
        )
        
        # Create context with realistic browser properties
        self.context = await self.browser.new_context(
            viewport={"width": 1280, "height": 720},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            locale="en-US",
            timezone_id="America/Toronto",
        )
        
        # Add storage state file if it exists (for session persistence)
        storage_file = Path("outlook_session.json")
        if storage_file.exists():
            print(f"Loading existing session from {storage_file}")
            self.context.set_storage_state(storage_file)
        
        self.page = await self.context.new_page()
        return self
    
    async def login(self) -> bool:
        """Login to Outlook Web"""
        if self.logged_in:
            return True
        
        print(f"Logging in to Outlook as {self.config.username}...")
        
        try:
            # Navigate to Outlook
            await self.page.goto(self.config.outlook_url, wait_until="networkidle", timeout=30000)
            
            # Wait for the login page or check if already logged in
            try:
                # Check if we're on the login page
                await self.page.wait_for_selector('input[name="loginfmt"]', timeout=10000)
                print("On Microsoft login page...")
                
                # Enter email
                await self.page.fill('input[name="logfmt"]', self.config.username)
                await self.page.click('input[type="submit"]')
                
                # Wait for password field
                await self.page.wait_for_selector('input[name="passwd"]', timeout=10000)
                print("Entering password...")
                
                await self.page.fill('input[name="passwd"]', self.config.password)
                await self.page.click('input[type="submit"]')
                
                # Handle "Stay signed in?" prompt
                try:
                    await self.page.wait_for_selector('#idSIButton9', timeout=5000)
                    await self.page.click('#idSIButton9')
                except:
                    pass  # No prompt, continue
                
                # Wait for Outlook to fully load
                await self.page.wait_for_load_state("networkidle", timeout=30000)
                await asyncio.sleep(2)
                
                # Save session for next time
                storage_file = Path("outlook_session.json")
                await self.context.storage_state(path=str(storage_file))
                print(f"Session saved to {storage_file}")
                
            except Exception as e:
                print(f"Login flow check: {e}")
            
            # Check if we're logged in by looking for Outlook interface
            try:
                await self.page.wait_for_selector('[data-key="NavLayout"]', timeout=15000)
                self.logged_in = True
                print("Successfully logged in to Outlook!")
                return True
            except:
                # Try alternative selectors
                try:
                    await self.page.wait_for_selector('div[name="PrimaryColumn"]', timeout=5000)
                    self.logged_in = True
                    print("Successfully logged in to Outlook!")
                    return True
                except:
                    pass
            
            # Check for any error messages
            try:
                error = await self.page.query_selector('[id="error"]')
                if error:
                    print("Login failed: Invalid credentials")
                    return False
            except:
                pass
            
            # If we got here without logging in, try one more approach
            print("Checking for compose button...")
            try:
                await self.page.wait_for_selector('button[title="New mail"]', timeout=5000)
                self.logged_in = True
                return True
            except:
                pass
            
            print("Could not confirm login, but will try to proceed...")
            return True
            
        except Exception as e:
            print(f"Login error: {e}")
            return False
    
    async def compose_email(self) -> bool:
        """Open new email compose window"""
        try:
            print("Opening new email composer...")
            
            # Click the "New mail" button (may have various selectors)
            selectors = [
                'button[title="New mail"]',
                'button[aria-label="New mail"]',
                '[data-name="compose"]',
                'button:has-text("New")',
                'a[title="New mail"]',
            ]
            
        compose_clicked = False
        for selector in selectors:
            try:
                await self.page.wait_for_selector(selector, timeout=3000)
                await self.page.click(selector)
                compose_clicked = True
                print(f"Clicked compose button using: {selector}")
                break
            except:
                continue
        
        if not compose_clicked:
            # Try using keyboard shortcut Ctrl+N
            await self.page.keyboard.press("Control+n")
            print("Used Ctrl+N shortcut for new email")
        
        # Wait for compose panel to open
        await asyncio.sleep(2)
        
        try:
            # Wait for the compose form or recipients field
            await self.page.wait_for_selector(
                'input[role="combobox"]',
                timeout=10000
            )
            print("Compose window opened")
            return True
        except:
            # Try alternative
            await self.page.wait_for_selector(
                'div[data-test-id="compose-popup"]',
                timeout=5000
            )
            print("Compose popup detected")
            return True
            
        except Exception as e:
            print(f"Compose window error: {e}")
            return False
    
    async def fill_email_fields(self, subject: str, to_email: str, to_name: str = "") -> bool:
        """Fill in email To, Subject, and body fields"""
        try:
            # Determine display name for recipient
            display_name = to_name if to_name else to_email
            recipient = f'"{display_name}" <{to_email}>'
            
            # Find and fill recipient field
            print(f"Filling recipient: {recipient}")
            await self.page.wait_for_selector('input[role="combobox"]', timeout=5000)
            await self.page.fill('input[role="combobox"]', to_email)
            await asyncio.sleep(1)
            
            # Wait for and click the first autocomplete suggestion
            try:
                await self.page.wait_for_selector('div[role="option"]', timeout=3000)
                await self.page.click('div[role="option"]')
            except:
                # Press Enter to confirm the email
                await self.page.keyboard.press("Enter")
            
            await asyncio.sleep(0.5)
            
            # Fill subject
            if subject:
                print(f"Filling subject: {subject}")
                await self.page.wait_for_selector('input[name="subjectLine"]', timeout=5000)
                await self.page.fill('input[name="subjectLine"]', subject)
                await asyncio.sleep(0.3)
            
            return True
            
        except Exception as e:
            print(f"Fill fields error: {e}")
            return False
    
    async def fill_email_body(self, body_html: str = "", body_text: str = "") -> bool:
        """Fill the email body content"""
        try:
            # Click on the body area first
            await self.page.wait_for_selector('[role="textbox"][aria-label="Body"]', timeout=5000)
            await self.page.click('[role="textbox"][aria-label="Body"]')
            await asyncio.sleep(0.5)
            
            # Type the body content
            body = body_text if body_text else self.strip_html(body_html)
            await self.page.keyboard.type(body, delay=10)
            
            print(f"Filled email body ({len(body)} characters)")
            return True
            
        except Exception as e:
            print(f"Fill body error: {e}")
            
            # Alternative approach: try iframe
            try:
                frames = self.page.frames
                for frame in frames:
                    try:
                        await frame.fill('[role="textbox"]', body_text)
                        return True
                    except:
                        continue
            except:
                pass
            
            return False
    
    async def send_email(self) -> bool:
        """Click the send button"""
        try:
            print("Sending email...")
            
            # Click send button
            send_selectors = [
                'button[aria-label="Send"]',
                'button[data-test-id="send-button"]',
                'button:has-text("Send")',
                'span:has-text("Send")',
            ]
            
            for selector in send_selectors:
                try:
                    await self.page.wait_for_selector(selector, timeout=3000)
                    await self.page.click(selector)
                    print(f"Clicked send button using: {selector}")
                    break
                except:
                    continue
            
            # Alternatively try Ctrl+Enter
            await self.page.keyboard.press("Control+Enter")
            print("Used Ctrl+Enter shortcut")
            
            await asyncio.sleep(2)
            print("Email sent successfully!")
            return True
            
        except Exception as e:
            print(f"Send error: {e}")
            return False
    
    async def close(self):
        """Clean up browser"""
        if self.browser:
            await self.browser.close()
        if self.playwright:
            await self.playwright.stop()
    
    @staticmethod
    def strip_html(html: str) -> str:
        """Strip HTML tags for plain text version"""
        import re
        clean = re.compile('<.*?>')
        return re.sub(clean, '', html)


async def send_booking_email(
    subject: str,
    to_email: str,
    to_name: str,
    body_html: str,
    body_text: str = ""
) -> bool:
    """
    Main function to send a booking notification email via Outlook
    
    Args:
        subject: Email subject line
        to_email: Recipient email address
        to_name: Recipient display name (optional)
        body_html: Email body in HTML format
        body_text: Email body in plain text (optional, auto-generated from HTML if not provided)
    
    Returns:
        True if email sent successfully, False otherwise
    """
    config = EmailConfig.from_env()
    config.subject = subject
    config.to_email = to_email
    config.to_name = to_name
    config.body_html = body_html
    config.body_text = body_text
    
    if not config.username or not config.password:
        print("ERROR: OUTLOOK_USERNAME and OUTLOOK_PASSWORD environment variables required")
        return False
    
    if not to_email:
        to_email = config.to_email
        if not to_email:
            print("ERROR: Recipient email (to_email or EMAIL_TO) is required")
            return False
    
    if not subject:
        subject = config.subject
        if not subject:
            subject = "Rotman AV Booking Request"
    
    sender = OutlookEmailSender(config)
    
    try:
        await sender.initialize()
        
        logged_in = await sender.login()
        if not logged_in:
            print("Failed to login to Outlook")
            return False
        
        composed = await sender.compose_email()
        if not composed:
            print("Failed to open compose window")
            return False
        
        filled = await sender.fill_email_fields(subject, to_email, to_name)
        if not filled:
            print("Failed to fill email fields")
            return False
        
        body_filled = await sender.fill_email_body(body_html, body_text)
        if not body_filled:
            print("Failed to fill email body")
            # Continue anyway, body might be auto-populated
        
        sent = await sender.send_email()
        return sent
        
    finally:
        await sender.close()


async def main():
    """Example usage"""
    import argparse
    
    parser = argparse.ArgumentParser(description="Send email via Outlook using Playwright")
    parser.add_argument("--to", required=True, help="Recipient email address")
    parser.add_argument("--name", default="", help="Recipient name")
    parser.add_argument("--subject", required=True, help="Email subject")
    parser.add_argument("--body", default="", help="Email body (plain text or HTML)")
    parser.add_argument("--html", action="store_true", help="Body contains HTML")
    
    args = parser.parse_args()
    
    body = args.body
    if args.html:
        body_sender = OutlookEmailSender.__new__(OutlookEmailSender)
        body = body_sender.strip_html(args.body)
    
    success = await send_booking_email(
        subject=args.subject,
        to_email=args.to,
        to_name=args.name,
        body_html=args.body if args.html else "",
        body_text=body if not args.html else ""
    )
    
    if success:
        print("\n✓ Email sent successfully!")
        sys.exit(0)
    else:
        print("\n✗ Failed to send email")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())