# zpty で対話 zsh を起動し、補完スクリプトを読み込んで TAB 補完の候補を集める。
# 使い方: zsh -f completion-driver.zsh <script> <workdir> <line>...
# 各 <line> を入力して TAB を 2 回押し、表示された候補を "=== <line>" の区切りで標準出力に出す。
zmodload zsh/zpty || { print -u2 "zsh/zpty is unavailable"; exit 3; }
script=$1 work=$2; shift 2

read_all() { # 出力が 1 秒途切れるまで読む
  local chunk out=""
  while zpty -r -t z chunk 2>/dev/null || { sleep 0.4; zpty -r -t z chunk 2>/dev/null }; do
    out+=$chunk
  done
  print -rn -- "$out"
}

export HOME=$work ZDOTDIR=$work TERM=xterm
zpty z "zsh -f -i"
zpty -w z "PS1='READY> '"
zpty -w z "unsetopt zle_bracketed_paste 2>/dev/null; stty cols 200 rows 50"
zpty -w z "autoload -Uz compinit && compinit -u -d $work/zcompdump && source $script"
zpty -w z "print SETUP\$((1+1))DONE"
setup=$(read_all)
[[ $setup == *SETUP2DONE* ]] || { print -u2 "setup failed: $setup"; exit 4 }
for line in "$@"; do
  zpty -w -n z "$line"$'\t\t'
  out=$(read_all)
  print -r -- "=== $line"
  print -r -- "$out"
  zpty -w -n z $'\x15'   # ^U で行をクリア
  read_all >/dev/null
done
zpty -d z
