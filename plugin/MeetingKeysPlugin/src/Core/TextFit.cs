namespace Loupedeck.MeetingKeysPlugin
{
    using System;
    using System.Collections.Generic;
    using System.Linq;
    using System.Text;

    // Fits a full term into a box: at most 2 lines broken between words, the largest font size that fits.
    // A word is abbreviated ("Quantiz.") only when it does not fit on a line at the smallest size; text that
    // needs more than 2 lines at the smallest size ends with "…". No SDK types, so it can be tested on its own
    // (tests/TextFitCheck). Widths are estimated from Brown Logitech Pan Bold advance widths (the service has no
    // public text measurement), so callers keep a small safety margin.
    public static class TextFit
    {
        public const String Ellipsis = "…";

        public sealed record Result(IReadOnlyList<String> Lines, Int32 FontSize, Int32 LineHeight, Boolean Abbreviated);

        // Advance widths in em of Brown Logitech Pan Bold (read from the font embedded in PluginApi.dll), for ' ' .. '~'.
        private static readonly Double[] Ascii =
        {
            0.242, 0.348, 0.45, 0.677, 0.57, 0.899, 0.696, 0.24, 0.328, 0.328, 0.518, 0.58, 0.332, 0.44, 0.32, 0.49,
            0.632, 0.386, 0.59, 0.597, 0.637, 0.574, 0.596, 0.54, 0.594, 0.596, 0.352, 0.358, 0.58, 0.58, 0.58, 0.529,
            0.95, 0.692, 0.641, 0.711, 0.746, 0.559, 0.536, 0.749, 0.773, 0.303, 0.497, 0.67, 0.538, 0.858, 0.773, 0.796,
            0.609, 0.8, 0.652, 0.557, 0.551, 0.748, 0.67, 0.979, 0.65, 0.653, 0.594, 0.39, 0.49, 0.39, 0.58, 0.6,
            0.34, 0.624, 0.624, 0.543, 0.624, 0.55, 0.434, 0.624, 0.624, 0.282, 0.29, 0.567, 0.282, 0.954, 0.624, 0.594,
            0.624, 0.624, 0.405, 0.459, 0.452, 0.615, 0.554, 0.818, 0.544, 0.582, 0.502, 0.379, 0.292, 0.379, 0.58,
        };

        private const Double DefaultWidth = 0.62; // accented letters and other symbols
        public const Double LineHeightFactor = 1.12;

        public static Double CharWidth(Char c)
        {
            if (c >= ' ' && c <= '~')
            {
                return Ascii[c - ' '];
            }

            return c switch
            {
                '…' => 0.93,
                '✓' => 0.76,
                '’' or '‘' => 0.24,
                '–' => 0.5,
                '—' => 0.9,
                _ => DefaultWidth,
            };
        }

        // Width in pixels of `text` at `fontSize` px.
        public static Double Width(String text, Int32 fontSize)
        {
            var em = 0.0;
            foreach (var c in text)
            {
                em += CharWidth(c);
            }

            return em * fontSize;
        }

        public static Int32 LineHeightFor(Int32 fontSize) => (Int32)Math.Ceiling(fontSize * LineHeightFactor);

        public static Result Fit(String text, Int32 boxWidth, Int32 boxHeight, Int32 maxSize, Int32 minSize)
        {
            var words = Words(text);
            minSize = Math.Max(1, Math.Min(minSize, maxSize));
            if (words.Count == 0)
            {
                return new Result(Array.Empty<String>(), maxSize, LineHeightFor(maxSize), false);
            }

            for (var size = maxSize; size >= minSize; size--)
            {
                var lineHeight = LineHeightFor(size);
                var maxLines = Math.Min(2, boxHeight / lineHeight);
                if (maxLines < 1)
                {
                    continue;
                }

                var one = String.Join(" ", words);
                if (Width(one, size) <= boxWidth)
                {
                    return new Result(new[] { one }, size, lineHeight, false);
                }

                if (maxLines >= 2 && words.Count >= 2)
                {
                    var split = BestSplit(words, size);
                    if (split != null && Math.Max(Width(split[0], size), Width(split[1], size)) <= boxWidth)
                    {
                        return new Result(split, size, lineHeight, false);
                    }
                }
            }

            return Abbreviate(words, boxWidth, boxHeight, minSize);
        }

        // A line this short on its own looks like a stray ("SOC" / "2"): such breaks are not used.
        public const Int32 MinLineChars = 3;

        // Two lines with the narrowest wider line (the most balanced break between words); null if every
        // break leaves a line shorter than MinLineChars.
        private static String[] BestSplit(List<String> words, Int32 size)
        {
            String[] best = null;
            var bestWidth = Double.MaxValue;
            for (var i = 1; i < words.Count; i++)
            {
                var a = String.Join(" ", words.Take(i));
                var b = String.Join(" ", words.Skip(i));
                if (a.Length < MinLineChars || b.Length < MinLineChars)
                {
                    continue;
                }

                var w = Math.Max(Width(a, size), Width(b, size));
                if (w < bestWidth)
                {
                    bestWidth = w;
                    best = new[] { a, b };
                }
            }

            return best;
        }

        // Smallest size: shorten words that do not fit on a line, pack greedily, cut beyond the last line with "…".
        private static Result Abbreviate(List<String> words, Int32 boxWidth, Int32 boxHeight, Int32 size)
        {
            var lineHeight = LineHeightFor(size);
            var maxLines = Math.Max(1, Math.Min(2, boxHeight / lineHeight));
            var abbreviated = false;
            var fitted = new List<String>();
            foreach (var w in words)
            {
                if (Width(w, size) <= boxWidth)
                {
                    fitted.Add(w);
                    continue;
                }

                abbreviated = true;
                fitted.Add(Shorten(w, ".", boxWidth, size));
            }

            var lines = new List<String>();
            var cur = "";
            foreach (var w in fitted)
            {
                var candidate = cur.Length == 0 ? w : cur + " " + w;
                if (cur.Length == 0 || Width(candidate, size) <= boxWidth)
                {
                    cur = candidate;
                }
                else
                {
                    lines.Add(cur);
                    cur = w;
                }
            }

            lines.Add(cur);
            if (lines.Count > maxLines)
            {
                var rest = String.Join(" ", lines.Skip(maxLines - 1));
                lines = lines.Take(maxLines - 1).ToList();
                lines.Add(Shorten(rest, Ellipsis, boxWidth, size, force: true));
                abbreviated = true;
            }

            return new Result(lines, size, lineHeight, abbreviated);
        }

        // The longest prefix of `s` that fits with `mark` appended ("Quantiz.", "deep rest …").
        private static String Shorten(String s, String mark, Int32 boxWidth, Int32 size, Boolean force = false)
        {
            if (!force && Width(s, size) <= boxWidth)
            {
                return s;
            }

            for (var n = s.Length - 1; n >= 1; n--)
            {
                var prefix = s.Substring(0, n).TrimEnd(' ', '-', ',');
                if (prefix.Length > 0 && Width(prefix + mark, size) <= boxWidth)
                {
                    return prefix + mark;
                }
            }

            return s.Substring(0, 1) + mark;
        }

        private static List<String> Words(String text)
        {
            var sb = new StringBuilder();
            foreach (var c in text ?? "")
            {
                sb.Append(Char.IsWhiteSpace(c) ? ' ' : c);
            }

            return sb.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
        }
    }
}
