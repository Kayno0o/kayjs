# Usage: perl -0pi rtcd-skip.pl cmake/rtcd.pl
# Lets libaom's rtcd generator drop specializations listed (one regex per line, matched against "<function>_<arch>") in the file named by $AOM_RTCD_SKIP.
s|(sub specialize \{.*?foreach my \$opt \(\@_\) \{\n)|$1    if (\$ENV{AOM_RTCD_SKIP} && open(my \$sf, "<", \$ENV{AOM_RTCD_SKIP})) { my \@re = grep { length } map { chomp; \$_ } <\$sf>; close \$sf; next if grep { "\${fn}_\${opt}" =~ /^\$_\$/ } \@re; }\n|s;
