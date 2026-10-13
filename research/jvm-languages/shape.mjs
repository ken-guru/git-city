import { Parser, Language } from 'web-tree-sitter';
const base = '/tmp/claude-1000/-workspace/29babd88-0ee3-42fc-9906-f088e1d90ef2/scratchpad/jvm/';
await Parser.init();
const java = await Language.load(base+'node_modules/tree-sitter-java/tree-sitter-java.wasm');
const ktG = await Language.load(base+'node_modules/@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm');
const ktF = await Language.load(base+'dl/fwcd-0.3.8.wasm');
console.log('ABI', java.abiVersion, ktG.abiVersion, ktF.abiVersion);
const p = new Parser();
const jsrc = `package com.example.app;
import java.util.List;
import java.util.*;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.*;
import com.example.app.Outer.Inner;
public class Foo { }
class Bar {}
interface Baz {}
enum E {A}
record R(int x) {}
@interface Ann {}
`;
p.setLanguage(java); console.log(p.parse(jsrc).rootNode.toString());
const ksrc = `@file:JvmName("Utils")
package com.example.app
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.*
import org.junit.Assert.assertEquals as eq
import com.example.app.Outer.Inner
class Foo
data class Bar(val x: Int)
object Baz
interface I
sealed interface S
enum class E { A }
typealias T = String
fun topLevel() = 1
val topVal = 2
private class Hidden
`;
for (const [n,l] of [['ktG',ktG],['ktF',ktF]]) { p.setLanguage(l); console.log(n, p.parse(ksrc).rootNode.toString()); }
