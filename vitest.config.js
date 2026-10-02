import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [
        cloudflareTest(async () => ({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
                bindings: {
                    TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
                    // Test-only logins and in-memory email
                    AUTH_USER: 'test-user',
                    AUTH_PASS: 'test-pass',
                    ADMIN_USER: 'test-admin',
                    ADMIN_PASS: 'test-admin-pass',
                    MAIL_MODE: 'test',
                    // Tests call the app at the root; the /book prefix has its own tests
                    BASE_PATH: ''
                }
            }
        }))
    ],
    test: {
        setupFiles: ['./test/apply-migrations.js']
    }
});
