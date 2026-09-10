/**
 * 假名 → 罗马字首字母表（供 gen-letter-keys.mjs 生成开字母判定表用）
 *
 * ⚠️ 这是**对 phi-plugin 的净增**：phi 的 `revealCharacter` 只对 `[一-鿿]` 走拼音，
 * 假名既不是 CJK 也不是拉丁，于是**永远开不出来**。而实测本库 1394 首里有 **669 首含假名**，
 * 不处理的话近半数题目只能靠整题猜。
 *
 * 取值口径：
 * - 基准用 **Hepburn 罗马字**（し=shi、ち=chi、つ=tsu、ふ=fu、じ=ji），玩家心智里最常见；
 * - 一个假名可以给**多个可接受首字母**（值为字符串，逐字符比对），把常见替代拼法一并收进来，
 *   如 `ち: 'ct'`（chi / ti）、`ふ: 'fh'`（fu / hu）、`を: 'ow'`（o / wo）；
 * - **促音 っ / ッ 留空**：它本身不发音（是「把后一个辅音加倍」的记号），
 *   给任何字母都会误导。玩家按后一个假名的首字母开即可（ロック → `open K` 翻 ク）。
 */
const HIRA = {
  ぁ: 'a', あ: 'a', ぃ: 'i', い: 'i', ぅ: 'u', う: 'u', ぇ: 'e', え: 'e', ぉ: 'o', お: 'o',
  か: 'k', き: 'k', く: 'k', け: 'k', こ: 'k',
  が: 'g', ぎ: 'g', ぐ: 'g', げ: 'g', ご: 'g',
  さ: 's', し: 's', す: 's', せ: 's', そ: 's',
  ざ: 'z', じ: 'jz', ず: 'z', ぜ: 'z', ぞ: 'z',
  た: 't', ち: 'ct', つ: 't', て: 't', と: 't',
  だ: 'd', ぢ: 'jd', づ: 'zd', で: 'd', ど: 'd',
  な: 'n', に: 'n', ぬ: 'n', ね: 'n', の: 'n',
  は: 'h', ひ: 'h', ふ: 'fh', へ: 'h', ほ: 'h',
  ば: 'b', び: 'b', ぶ: 'b', べ: 'b', ぼ: 'b',
  ぱ: 'p', ぴ: 'p', ぷ: 'p', ぺ: 'p', ぽ: 'p',
  ま: 'm', み: 'm', む: 'm', め: 'm', も: 'm',
  ゃ: 'y', や: 'y', ゅ: 'y', ゆ: 'y', ょ: 'y', よ: 'y',
  ら: 'r', り: 'r', る: 'r', れ: 'r', ろ: 'r',
  ゎ: 'w', わ: 'w', ゐ: 'i', ゑ: 'e', を: 'ow', ん: 'n',
  ゔ: 'v',
  っ: '',
}

/** 平假名 → 片假名（主区 U+3041–U+3096 整体偏移 +0x60） */
export function expandKatakana(hira = HIRA) {
  const out = {}
  for (const [ch, initials] of Object.entries(hira)) {
    const code = ch.codePointAt(0)
    if (code < 0x3041 || code > 0x3096) continue
    out[String.fromCodePoint(code + 0x60)] = initials
  }
  // 片假名专属：长音符（不发音，与促音同理留空 ⇒ 实际按「不收录」处理，永不翻开）
  return out
}

export function kanaInitials() {
  return { ...HIRA }
}
