using HarmonyLib;
using UnityEngine;

namespace CorticoOvercooked2
{
    /// <summary>
    /// The chalkboard a campaign level opens with: LevelIntroFlowroutine's TutorialPopup, which the
    /// intro shows paused until a player holds a button for a second or 15 seconds pass. Its
    /// title and description are localisation tags rendered over the steps picture at runtime,
    /// so the plugin reports them localised and screenshots the board as players see it.
    /// </summary>
    internal static class Board
    {
        private static readonly AccessTools.FieldRef<LevelIntroFlowroutine, LevelIntroFlowroutineData> Data =
            AccessTools.FieldRefAccess<LevelIntroFlowroutine, LevelIntroFlowroutineData>("m_data");

        private static readonly AccessTools.FieldRef<ClientTutorialPopupController, GameObject> Popup =
            AccessTools.FieldRefAccess<ClientTutorialPopupController, GameObject>("m_popup");

        private static GameObject _reported;

        /// <summary>The board's popup the first time it is up, otherwise null.</summary>
        public static GameObject NewlyShown()
        {
            var controller = Object.FindObjectOfType<ClientTutorialPopupController>();
            var popup = controller != null ? Popup(controller) : null;
            if (popup == null || !popup.activeInHierarchy || popup == _reported) return null;
            _reported = popup;
            return popup;
        }

        /// <summary>The level's board as an `ev` frame without the picture: sprite name, title, description, label.</summary>
        public static JObj Describe()
        {
            var ev = Hooks.Ev("board");
            var intro = Object.FindObjectOfType<LevelIntroFlowroutine>();
            var popup = intro != null ? Data(intro)?.TutorialPopup : null;
            if (popup == null) return ev;
            if (popup.SplashImage != null) ev.Str("sprite", popup.SplashImage.name);
            ev.Str("title", Text(popup.Title)).Str("body", Text(popup.Description)).Str("label", Text(popup.LabelText));
            return ev;
        }

        private static string Text(string tag)
        {
            if (string.IsNullOrEmpty(tag)) return null;
            var text = Localization.Get(tag);
            return string.IsNullOrEmpty(text) ? tag : text;
        }
    }
}
