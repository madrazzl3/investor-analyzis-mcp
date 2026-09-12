import { Password } from '@convex-dev/auth/providers/Password';
import { convexAuth } from '@convex-dev/auth/server';

// Pilot login. Recovery and verified-email invitations must precede public launch.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      validatePasswordRequirements(password) {
        if (password.length < 12 || password.length > 256)
          throw new Error('Password must contain 12–256 characters');
      },
    }),
  ],
});
