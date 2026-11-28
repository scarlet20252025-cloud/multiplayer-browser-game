#!/usr/bin/env python3
"""生成本次交付的两份机器可读清单。

输入：local/reports/ 下的 SWF 检查结果与基准运行结果。
输出：evidence/original-games/manifest.json 与 baseline-results.json。

只读取本地结果，不改动原包。
"""
import hashlib
import json
import os
from datetime import datetime, timezone, timedelta

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
REPORTS = os.path.join(REPO, 'local', 'reports')
OUT_DIR = os.path.join(REPO, 'evidence', 'original-games')
COMMIT = '1d31780d6e64be65f9c18adaeef6f6a7536578ee'
TZ = timezone(timedelta(hours=8))
NOW = datetime.now(TZ).replace(microsecond=0).isoformat()

# 公开分发判定：两份来源都只声明「保存与研究」，未授予再分发权。
REDIST = {
    'publicRedistribution': 'restricted',
    'basis': '原归档 README 注明仅供保存与学习研究、禁止再发布素材；未获得原作者或发行方的再分发授权。',
    'repositoryPath': None,
    'availability': 'private-local',
}

SOURCE = {
    '1-forest-temple_addictinggames.swf': 'AddictingGames 发行版（Flash 保存计划 / Internet Archive 取得）',
    '1-forest-temple_kizi.swf': 'KIZI 发行版（Internet Archive 取得）',
    '1-forest-temple_sikids.swf': 'SIKIDS 发行版（Internet Archive 取得）',
    '2-light-temple.swf': '光之神殿，后期重编版（Internet Archive 取得）',
    '2-light-temple_alt.swf': '光之神殿，原始版（Internet Archive 取得）',
    '3-ice-temple.swf': '冰之神殿（Internet Archive 取得）',
    '4-crystal-temple.swf': '水晶神殿（Internet Archive 取得）',
    'shanyi-binary.swf': '4399 发行版外层壳（Flash 保存计划原件，SHA-256 逐字节校验通过）',
    'core-game.swf': '从外层壳内嵌的 DefineBinaryData 剥出的第二层壳（派生）',
    'core_1.swf': '4399 分片脱壳产物：加载器（派生）',
    'core_2.swf': '4399 分片脱壳产物：提示页（派生）',
    'core_3.swf': '4399 分片脱壳产物：纯代码包 3×DoABC（派生）',
    'core_4.swf': '4399 分片脱壳产物：纯资源包（派生）',
    'extracted-C-lightning.swf': '《闪翼双星之闪电行动》续作，未加壳（派生自加壳版本，对照用）',
}


def load(name):
    with open(os.path.join(REPORTS, name), encoding='utf-8') as fh:
        return json.load(fh)


def swf_index():
    idx = {}
    for name in ('swf-fireboy.json', 'swf-shanyi.json'):
        data = load(name)
        for f in data['files']:
            idx[f['path']] = f
    return idx


def file_entry(idx, filename, role, modified):
    info = idx.get(filename)
    if not info:
        return None
    stage = info.get('stage') or {}
    return {
        'relativePath': filename,
        'role': role,
        'bytes': info['bytes'],
        'sha256': info['sha256'],
        'modified': modified,
        'source': SOURCE.get(filename, '未知'),
        'swfHeader': {
            'signature': info.get('signature'),
            'swfVersion': info.get('swfVersion'),
            'declaredLength': info.get('declaredLength'),
            'lengthMatchesDeclared': info.get('lengthMatchesDeclared'),
            'stage': {'width': stage.get('width'), 'height': stage.get('height')},
            'frameRate': info.get('frameRate'),
            'frameCount': info.get('frameCount'),
            'avmType': info.get('avmType'),
            'fileAttributesAs3Flag': (info.get('fileAttributes') or {}).get('as3Flag'),
            'embedded': info.get('embedded'),
        },
        **REDIST,
    }


def main():
    idx = swf_index()
    os.makedirs(OUT_DIR, exist_ok=True)

    fireboy_files = []
    for name, role in [
        ('1-forest-temple_addictinggames.swf', 'entry'),
        ('1-forest-temple_kizi.swf', 'archive'),
        ('1-forest-temple_sikids.swf', 'archive'),
        ('2-light-temple.swf', 'archive'),
        ('2-light-temple_alt.swf', 'archive'),
        ('3-ice-temple.swf', 'archive'),
        ('4-crystal-temple.swf', 'archive'),
    ]:
        entry = file_entry(idx, name, role, False)
        if entry:
            fireboy_files.append(entry)

    shanyi_files = []
    for name, role in [
        ('shanyi-binary.swf', 'entry+loader'),
        ('core-game.swf', 'core'),
        ('core_1.swf', 'asset'),
        ('core_2.swf', 'asset'),
        ('core_3.swf', 'core'),
        ('core_4.swf', 'asset'),
        ('extracted-C-lightning.swf', 'archive'),
    ]:
        entry = file_entry(idx, name, role, name.startswith('core_') or name == 'core-game.swf')
        if entry:
            shanyi_files.append(entry)

    manifest = {
        'schemaVersion': 1,
        'recordedAt': NOW,
        'repositoryCommit': COMMIT,
        'scope': '仅记录本地实际存在的文件；哈希不等于已提供原文件。',
        'games': [
            {
                'gameId': 'fireboy-1',
                'displayName': '森林冰火人 第一代（Fireboy and Watergirl in the Forest Temple）',
                'versionDescription': '2009 年 Flash 原版；本地有 AddictingGames / KIZI / SIKIDS 三个发行打包',
                'sourceVersionMatch': {
                    'status': 'matched',
                    'basis': 'Game.as 与 level.as 的 SHA-256 与远程审计值完全一致；'
                             '且 addictinggames 包头的 640×520 与源码 [SWF(width=640,height=520)] 相符。',
                    'gameAsSha256': 'c0df054d2ce56525f749b93eff0e2d25c9dbda00cb69311be2c4f732b58646cd',
                    'levelAsSha256': '1f38948cdbf0ab437af554ca9fbadfea834743ed4579ae3df69516d05b2f4229'
                },
                'materialsLocated': 'partial',
                'missing': [
                    '获准在非 addictinggames.com 域名下运行的授权版本',
                    '_assets/assets.swf（level.as:22 的 Embed 目标，仅影响重新构建）'
                ],
                'entrypoint': '1-forest-temple_addictinggames.swf',
                'launchParameters': [],
                'dependencies': {
                    'assetsEmbedded': True,
                    'externalRuntimeDependency': 'AGdom.initDomain() 要求 loaderURL 含 addictinggames.com 或 shockwave.com',
                    'detail': '素材全部内嵌（494 图形 / 27 音频 / 14 字体）；但 SDK 初始化依赖发行站点，'
                              '本地 127.0.0.1 下 getServer() 不执行，预加载回调不触发。'
                },
                'files': fireboy_files,
                'materialsAvailableToRemoteAgent': False,
                'materialsAvailableToRemoteAgentMissing': [
                    '1-forest-temple_addictinggames.swf（1,864,205 B）',
                    '1-forest-temple_kizi.swf（1,994,152 B）',
                    '1-forest-temple_sikids.swf（1,857,391 B）'
                ]
            },
            {
                'gameId': 'shanyi-core',
                'displayName': '闪翼双星 正传（4399 发行）',
                'versionDescription': '2011 年 Flash 原版，三层加载链；续作《闪电行动》不在本条目内',
                'sourceVersionMatch': {
                    'status': 'partial',
                    'basis': '源码目录结构与远程审计一致（987 个 .as、27,091 处 §§ 伪指令）；'
                             '但正传原始 SWF 的哈希无法与远程核对，因为远程从未取得该文件。',
                    'note': 'core_3.swf 由本地脱壳得到，SHA-256 可与本清单核对，不能与远程已有值比对。'
                },
                'materialsLocated': 'complete',
                'missing': [
                    '平台中立版本或移除 cdn.comment.4399pk.com 依赖的授权构建',
                    '原始 FLA / 可编译 AS3 工程（仅影响重新构建）'
                ],
                'entrypoint': 'shanyi-binary.swf',
                'launchParameters': [],
                'dependencies': {
                    'assetsEmbedded': True,
                    'externalRuntimeDependency': 'http://cdn.comment.4399pk.com/control/A4399dv_base.swf（CORS 拦截）',
                    'alchemyInSwf': True,
                    'detail': 'cmodule.Box2D 的类都在 core_3.swf 的 DoABC 内，不需要外部 DLL；'
                              '素材在 core_4.swf 内。运行只差绕开 4399 平台模块。'
                },
                'files': shanyi_files,
                'materialsAvailableToRemoteAgent': False,
                'materialsAvailableToRemoteAgentMissing': [
                    'shanyi-binary.swf（3,485,489 B）',
                    'core-game.swf（3,457,698 B）',
                    'core_1..core_4.swf（脱壳产物）'
                ]
            }
        ]
    }

    with open(os.path.join(OUT_DIR, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
        fh.write('\n')

    # ---------- baseline-results ----------
    def shot_hash(rel):
        path = os.path.join(REPO, rel)
        if not os.path.exists(path):
            return None
        raw = open(path, 'rb').read()
        return {'path': rel, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}

    def baseline(name, entry_sha, extra=None):
        data = load(name)
        shots = []
        for s in data.get('screenshots', []):
            # 清单里统一用正斜杠，避免 Windows 反斜杠在 JSON 中需要转义
            rel = '/'.join(['local', 'screenshots',
                            os.path.basename(os.path.dirname(s['path'])),
                            os.path.basename(s['path'])])
            item = shot_hash(rel)
            if item:
                shots.append(item)
        return {
            'entry': data['entry'],
            'fileSha256': entry_sha,
            'runtime': {'ruffle': '0.7.1', 'browser': 'chromium-headless-shell 151.0.7922.34'},
            'loadStatus': data['load']['status'],
            'metadata': data['load'].get('metadata'),
            'checks': data['checks'],
            'errors': (data.get('pageErrors') or []) + (data.get('failedRequests') or []) + (data.get('badResponses') or []),
            'consoleWarnings': [c for c in (data.get('console') or []) if c['type'] == 'error'][:5],
            'screenshots': shots,
            **(extra or {})
        }

    fireboy_entries = {}
    for key, fname in [
        ('addictinggames', 'baseline-1-forest-temple_addictinggames.json'),
        ('kizi', 'baseline-1-forest-temple_kizi.json'),
        ('sikids', 'baseline-1-forest-temple_sikids.json'),
    ]:
        fireboy_entries[key] = baseline(fname, None)

    # 补 entry 的 sha256
    for key, fname in [('addictinggames', '1-forest-temple_addictinggames.swf'),
                       ('kizi', '1-forest-temple_kizi.swf'),
                       ('sikids', '1-forest-temple_sikids.swf')]:
        info = idx.get(fname)
        if info:
            fireboy_entries[key]['fileSha256'] = info['sha256']

    shanyi_bin = baseline('baseline-shanyi-binary.json', None)
    if idx.get('shanyi-binary.swf'):
        shanyi_bin['fileSha256'] = idx['shanyi-binary.swf']['sha256']
    lightning = baseline('baseline-extracted-C-lightning.json', None)
    if idx.get('extracted-C-lightning.swf'):
        lightning['fileSha256'] = idx['extracted-C-lightning.swf']['sha256']
    core3 = baseline('baseline-decrypted_core_3.json', None)
    if idx.get('core_3.swf'):
        core3['fileSha256'] = idx['core_3.swf']['sha256']

    results = {
        'schemaVersion': 1,
        'recordedAt': NOW,
        'testedCommit': COMMIT,
        'workingTreeDirty': True,
        'workingTreeNote': '被测代码未改动；工作区差异仅为本次新增的报告、清单与证据目录。',
        'environment': {
            'os': 'Windows 11',
            'node': 'v22.22.2',
            'npm': '10.9.7',
            'python': '3.13.14',
            'playwright': '1.62.1',
            'browser': 'chromium-headless-shell 151.0.7922.34 (SwiftShader)',
            'ruffle': '0.7.1 (package-lock.json)',
            'bind': '127.0.0.1 only',
            'harness': 'scripts/original-game-host.mjs + scripts/verify-original-baseline.mjs（本次原创）'
        },
        'games': [
            {
                'gameId': 'fireboy-1',
                'baselinePlayable': False,
                'netplayVerified': False,
                'blockers': [
                    'AGdom.initDomain() 的发行站点绑定：loaderURL 不含 addictinggames.com / shockwave.com 时，'
                    'getServer() 不执行，AGinitToolkit(CreatePreloader) 的回调永不触发，影片停在预加载帧。',
                    '未采用 hosts 伪造或改写绑定等绕行手段，因此记为 blocked 而非 passed。'
                ],
                'observation': '三个发行版本表现一致：Ruffle 加载成功、isPlaying=true、预加载圆弧持续旋转、'
                               '无 AS3 异常、无 404；8–15 秒内始终未进入菜单。',
                'runs': fireboy_entries
            },
            {
                'gameId': 'shanyi-core',
                'baselinePlayable': False,
                'netplayVerified': False,
                'blockers': [
                    '外层壳请求 http://cdn.comment.4399pk.com/control/A4399dv_base.swf，被 CORS 拦截（net::ERR_FAILED）。',
                    'core_3（纯代码）与 core_4（纯资源）尚未合并，合并后能否独立运行未验证。'
                ],
                'observation': 'shanyi-binary.swf 能被 Ruffle 解析并创建 WebGL 画布（800×600 @30fps），'
                               '但平台模块请求失败；脱壳后的 core_3.swf 单独加载为纯白画面，符合「只有代码、没有资源」。',
                'runs': {'original': shanyi_bin, 'decryptedCore3Only': core3}
            },
            {
                'gameId': 'shanyi-lightning',
                'displayName': '闪翼双星之闪电行动（对照，非正传）',
                'baselinePlayable': True,
                'netplayVerified': False,
                'purpose': '仅用于证明本地 Ruffle 0.7.1 与闪翼引擎链路可用；不能替代正传验收。',
                'observation': '完整显示主菜单：标题「闪翼双星 之闪电行动 体验版」、开始游戏 / 更多游戏按钮、'
                               '角色立绘、底部工具栏（主页 / 设置 / 帮助 / 音乐 / 奖杯 / 全屏）、版本号 0.001。',
                'runs': {'lightning': lightning}
            }
        ],
        'probeBaseline': {
            'runId': '20261117T152855-windows-node22',
            'path': 'evidence/local-agent/probe-baseline/20261117T152855-windows-node22/',
            'summary': ('npm test exit 0；test:python 12/13（1 项 Windows 换行缺陷）；'
                        'check:utf8 exit 0；test:network passed 8/8；test:e2e passed 13/13'),
            'note': '本次为本机复现，不是 GitHub Actions 重跑；未覆盖历史 CI 证据。'
        },
        'notCovered': [
            '未修改原包的通关验证（0 关）',
            '双角色独立控制（未进入关卡，无法测试）',
            '原游戏输入桥与联机适配',
            '音频验收',
            '公网或异地网络条件'
        ]
    }

    with open(os.path.join(OUT_DIR, 'baseline-results.json'), 'w', encoding='utf-8') as fh:
        json.dump(results, fh, ensure_ascii=False, indent=2)
        fh.write('\n')

    print('已写入 manifest.json 与 baseline-results.json')
    print('manifest games:', len(manifest['games']))
    print('baseline games:', len(results['games']))


if __name__ == '__main__':
    main()
