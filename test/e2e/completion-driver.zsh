# zpty で対話 zsh を起動し、補完スクリプトを読み込んで TAB 補完の候補を集める。
# 使い方: zsh -f completion-driver.zsh <script> <workdir> <line>...
# 各 <line> を入力して TAB を 2 回押し、表示された候補を "=== <line>" の区切りで標準出力に出す。
#
# 安定性のための設計:
# - 端末サイズは zpty の子プロセス側（zsh 起動前）で stty 設定する。起動後に入力行で設定すると、
#   反映前の長い行が 80 桁で折り返されてエコーが崩れる。
# - セットアップ（compinit / source / プロンプト）は入力行に流さず、ZDOTDIR の .zshrc で読み込む。
#   完了は固有のマーカー出力を待って同期する（固定 sleep に頼らない）。
zmodload zsh/zpty || { print -u2 "zsh/zpty is unavailable"; exit 3; }
script=$1 work=$2; shift 2

# 出力が $1 秒（既定 0.4）途切れるまで読む。最初の出力が来るまでは最大 $2 秒（既定 10）待つ。
read_all() {
  local idle=${1:-0.4} first=${2:-10} chunk out="" i
  for ((i = 0; i < first * 10; i++)); do
    zpty -r -t z chunk 2>/dev/null && { out+=$chunk; break }
    sleep 0.1
  done
  while zpty -r -t z chunk 2>/dev/null || { sleep $idle; zpty -r -t z chunk 2>/dev/null }; do
    out+=$chunk
  done
  print -rn -- "$out"
}

# マーカーが現れるまで最大 $2 秒読み続ける。見つかれば 0。
wait_marker() {
  local marker=$1 limit=${2:-30} chunk acc="" i
  for ((i = 0; i < limit * 10; i++)); do
    while zpty -r -t z chunk 2>/dev/null; do acc+=$chunk; done
    [[ $acc == *$marker* ]] && return 0
    sleep 0.1
  done
  print -u2 "marker $marker not seen: $acc"
  return 1
}

# ZDOTDIR の .zshrc でセットアップする（マーカーは式展開後にだけ現れる）。
cat > $work/.zshrc <<RC
PS1='READY> '
unsetopt zle_bracketed_paste 2>/dev/null
autoload -Uz compinit && compinit -u -d $work/zcompdump && source $script
print SETUP\$((1+1))DONE
RC

export HOME=$work ZDOTDIR=$work TERM=xterm COLUMNS=200 LINES=50
# stty は zsh 起動前（zpty の子側）で設定する。-d はグローバル rc を読まず ZDOTDIR/.zshrc だけ読む。
zpty z "stty cols 200 rows 50; exec zsh -d -i"
wait_marker SETUP2DONE 30 || exit 4
read_all 0.4 1 >/dev/null   # 最初のプロンプトまで読み捨てる
for line in "$@"; do
  zpty -w -n z "$line"$'\t\t'
  out=$(read_all)
  print -r -- "=== $line"
  print -r -- "$out"
  zpty -w -n z $'\x15'   # ^U で行をクリア
  read_all 0.4 2 >/dev/null
done
zpty -d z
