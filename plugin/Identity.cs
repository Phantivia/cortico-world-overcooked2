using Team17.Online;

namespace CorticoOvercooked2
{
    /// <summary>
    /// Names and colours of the two local players, set by the World's `identity` request. The
    /// server user system hands out chef colours by join order (player one blue, player two red)
    /// whenever a user joins or leaves, and copies its users to the client side; Plugin calls Apply
    /// twice a second, which rewrites the names and swaps the colours back on the server users.
    /// A chef takes its colour when the level loads, so the swap is in place before that.
    /// </summary>
    internal static class Identity
    {
        public static string BotName;
        public static string PartnerName;
        public static bool BotFirstColour;

        public static void Set(string botName, string partnerName, bool botFirstColour)
        {
            BotName = string.IsNullOrEmpty(botName) ? null : botName;
            PartnerName = string.IsNullOrEmpty(partnerName) ? null : partnerName;
            BotFirstColour = botFirstColour;
            Apply();
        }

        public static void Apply()
        {
            var botSlot = Seat.Slot;
            if (botSlot == null) return;
            User bot = null, partner = null;
            var users = ServerUserSystem.m_Users;
            if (users == null) return;
            for (int i = 0; i < users.Count; i++)
            {
                var u = users._items[i];
                if (u == null || !u.IsLocal) continue;
                if (u.Engagement == botSlot.Value) bot = u;
                else if (u.Engagement == EngagementSlot.One) partner = u;
            }
            if (bot != null && BotName != null && bot.DisplayName != BotName) bot.DisplayName = BotName;
            if (partner != null && PartnerName != null && partner.DisplayName != PartnerName) partner.DisplayName = PartnerName;
            if (bot != null && partner != null && BotFirstColour && bot.Colour > partner.Colour)
            {
                uint first = bot.Colour;
                bot.Colour = partner.Colour;
                partner.Colour = first;
            }
        }
    }
}
