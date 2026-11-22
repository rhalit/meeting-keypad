namespace Loupedeck.MeetingKeysPlugin.Checks
{
    using System;
    using System.Linq;

    // Plain checks for TextFit, for a 116 px key: term box ~ 100 x 75 px, sizes 35 .. 15 px.
    public static class Program
    {
        private const Int32 W = 100;
        private const Int32 H = 75;
        private const Int32 Max = 35;
        private const Int32 Min = 15;
        private static Int32 failures;

        private static void Check(String name, Boolean ok, String detail)
        {
            Console.WriteLine($"{(ok ? "ok  " : "FAIL")} {name}: {detail}");
            if (!ok)
            {
                failures++;
            }
        }

        private static String Show(TextFit.Result r) =>
            $"{r.FontSize}px [{String.Join(" | ", r.Lines)}]{(r.Abbreviated ? " abbreviated" : "")}";

        private static Boolean FitsBox(TextFit.Result r, Int32 w, Int32 h) =>
            r.Lines.All(l => TextFit.Width(l, r.FontSize) <= w) && r.Lines.Count * r.LineHeight <= h && r.Lines.Count <= 2;

        public static Int32 Main()
        {
            var rag = TextFit.Fit("RAG", W, H, Max, Min);
            Check("short term: one line at the largest size", rag.Lines.Count == 1 && rag.FontSize == Max && !rag.Abbreviated, Show(rag));

            var vdb = TextFit.Fit("Vector database", W, H, Max, Min);
            Check("two words: broken between words into 2 lines", vdb.Lines.SequenceEqual(new[] { "Vector", "database" }) && !vdb.Abbreviated, Show(vdb));
            Check("two words: fits the box", FitsBox(vdb, W, H), Show(vdb));

            var q = TextFit.Fit("Quantization", W, H, Max, Min);
            Check("one long word: shrinks, not abbreviated", q.Lines.SequenceEqual(new[] { "Quantization" }) && q.FontSize < Max && q.FontSize >= Min && !q.Abbreviated, Show(q));

            var longer = TextFit.Fit("Canary release", W, H, Max, Min);
            var shorter = TextFit.Fit("LoRA", W, H, Max, Min);
            Check("longer text gets a smaller font", longer.FontSize < shorter.FontSize, $"{Show(longer)} vs {Show(shorter)}");

            var huge = TextFit.Fit("Electroencephalography", W, H, Max, Min);
            Check("a word too long even at the smallest size is abbreviated with '.'", huge.Abbreviated && huge.FontSize == Min && huge.Lines[0].EndsWith(".") && FitsBox(huge, W, H), Show(huge));

            var four = TextFit.Fit("Total addressable market size", W, H, Max, Min);
            Check("4 words: 2 lines, all text kept or cut with …", four.Lines.Count == 2 && FitsBox(four, W, H), Show(four));

            var many = TextFit.Fit("Retrieval augmented generation pipeline for enterprise search", W, H, Max, Min);
            Check("more than 2 lines at the smallest size: ends with …", many.Lines.Count == 2 && many.Lines[1].EndsWith(TextFit.Ellipsis) && many.Abbreviated && FitsBox(many, W, H), Show(many));

            var balanced = TextFit.Fit("Non-sleep deep rest", W, H, Max, Min);
            Check("3 words: the most balanced break", balanced.Lines.Count == 2 && !balanced.Abbreviated && FitsBox(balanced, W, H), Show(balanced));

            var flat = TextFit.Fit("Cold start", 200, 30, Max, Min);
            Check("a low box allows 1 line only", flat.Lines.Count == 1 && FitsBox(flat, 200, 30), Show(flat));

            var newline = TextFit.Fit("Catch\nup", W, H, Max, Min);
            Check("\\n counts as a space", newline.Lines.SequenceEqual(new[] { "Catch up" }) || newline.Lines.SequenceEqual(new[] { "Catch", "up" }), Show(newline));

            var soc2 = TextFit.Fit("SOC 2", W, H, Max, Min);
            Check("no stray short line: SOC 2 stays on one line", soc2.Lines.SequenceEqual(new[] { "SOC 2" }), Show(soc2));

            var pen = TextFit.Fit("Pen test", W, H, Max, Min);
            var penOneLine = TextFit.Fit("Pen test", W, 40, Max, Min);
            Check("two real words may still break for a bigger font", pen.Lines.SequenceEqual(new[] { "Pen", "test" }) && pen.FontSize > penOneLine.FontSize, $"{Show(pen)} vs one line {Show(penOneLine)}");

            var empty = TextFit.Fit("", W, H, Max, Min);
            Check("empty text: no lines", empty.Lines.Count == 0, Show(empty));

            Check("width table: W wider than i", TextFit.CharWidth('W') > TextFit.CharWidth('i'), $"{TextFit.CharWidth('W')} vs {TextFit.CharWidth('i')}");

            Console.WriteLine(failures == 0 ? "all TextFit checks passed" : $"{failures} TextFit check(s) FAILED");
            return failures == 0 ? 0 : 1;
        }
    }
}
