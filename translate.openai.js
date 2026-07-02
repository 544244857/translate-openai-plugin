/*
	translate.openai.js - 为 translate.js 接入自定义 OpenAI 兼容翻译 API 的插件
	通过 monkey-patch translate.request.post 实现拦截，不修改原 translate.js
	作者：opencode 生成
	依赖：translate.js (v3.x) 已加载
	运行环境：Electron (nodeIntegration:true) 或普通浏览器
*/
(function(){
	if(typeof translate !== 'object' || typeof translate.version !== 'string'){
		console.error('[translate.openai] translate.js 未加载，插件无法初始化');
		return;
	}
	if(typeof translate.service.openai !== 'undefined'){
		console.warn('[translate.openai] 已加载过，跳过重复加载');
		return;
	}

	// ===== 默认配置 =====
	var DEFAULT_CONFIG = {
		enabled: true,                                   // 总开关：true 大模型翻译，false 关闭走 Edge 原生
		endpoint: '',                                    // 例 https://api.deepseek.com/v1/chat/completions
		apiKey: '',
		model: 'deepseek-chat',
		batchSize: 10,                                   // 每批文本条数上限
		batchCharLimit: 1000,                            // 每批字符上限（长文本自动少分几条，与 batchSize 取较小者）
		maxConcurrency: 5,                               // 并行池上限
		requestTimeout: 60000,                           // 单请求超时 ms
		scene: '游戏文本翻译',                            // 翻译场景，注入提示词
		temperature: 0.6,
		promptTemplate:                                  // 提示词模板，支持 {from}{to}{scene}{content}{sep}{context}{outputFormat}
			'【角色】你是专业翻译家，当前翻译场景：{scene}。\n' +
			'{context}' +
			'【任务】将以下{from}文本翻译为{to}。\n' +
			'【输出格式】{outputFormat}\n' +
			'【硬性规则】\n' +
			'1. 译文必须与原文条数严格一一对应；\n' +
			'2. 保持原文的换行、标点风格、HTML 占位符、变量名、数字编号格式；\n' +
			'3. 不翻译已是中国大陆中文的原文，原样返回；\n' +
			'4. 只输出翻译结果，禁止任何解释、注释、前后缀。\n'+
			'5. 追求地道、自然、流畅的译文，像母语者说话一样，而不是逐字翻译。\n' +
			'6. 大胆润色：可以调整语序、补充省略词、使用成语俗语、转换语气，\n' +
			'   让译文更有表现力和感染力，只要核心意思不变。\n' +
			'7. 对于对话、俚语、情感表达，用符合语境的口语化表达，不要翻成书面语。\n' +
			'【原文】\n{content}',
		separator: '\n@@TiTS_SEP@@\n',                   // 批量分隔符（分隔符模式用）
		outputFormat: 'json',                            // 'json' | 'separator'，默认 JSON 输出
		progressiveOutput: false,                        // 渐进式输出（实验性，默认关，跟 translate.js 状态机有冲突）
		autoRecoverInterval: 60000,                      // 降级后探测恢复间隔 ms
		degradeThreshold: 3,                             // 连续失败多少次触发降级
		contextEnabled: true,                            // 上下文增强开关
		contextLimit: 300,                               // 全量上下文的字符上限
		contextWindow: 5,                                // 超限时当前批前后各取多少条作为上下文
		retryOnFormatError: true,                        // 格式异常时用更严格提示词重试 1 次
		degradeParallel: true                            // 降级逐条时并行（而非串行）
	};

	// ===== 语言映射（translate.js id -> 自然语言名）=====
	var LANG_MAP = {
		'chinese_simplified':'简体中文','chinese_traditional':'繁體中文','english':'English',
		'japanese':'日本語','korean':'한국어','french':'Français','german':'Deutsch',
		'spanish':'Español','russian':'Русский','portuguese':'Português','italian':'Italiano',
		'dutch':'Nederlands','arabic':'العربية','thai':'ไทย','vietnamese':'Tiếng Việt',
		'indonesian':'Bahasa Indonesia','malay':'Bahasa Melayu','turkish':'Türkçe',
		'polish':'Polski','czech':'Čeština','hungarian':'Magyar','swedish':'Svenska',
		'finnish':'Suomi','danish':'Dansk','norwegian':'Norsk','greek':'Ελληνικά',
		'hebrew':'עברית','hindi':'हिन्दी','romanian':'Română','ukrainian':'Українська'
	};
	var LANG_JSON = [];
	for(var k in LANG_MAP){
		if(LANG_MAP.hasOwnProperty(k)){
			LANG_JSON.push({id:k, name:LANG_MAP[k], serviceId:k});
		}
	}

	// ===== 插件对象 =====
	translate.service.openai = {
		config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
		state: {
			mode: 'openai',          // 'openai' | 'degraded'
			lastDegradedAt: null,
			lastRecoveredAt: null,
			degradeReason: '',
			consecutiveFailures: 0,
			recoverTimer: null,
			stats: { totalRequests:0, batchDegradedCount:0, failedCount:0, successCount:0 }
		},
		language: { map: LANG_MAP, json: LANG_JSON },

		// ===== 激活服务 =====
		use: function(userConfig){
			// 合并配置
			if(userConfig && typeof userConfig === 'object'){
				for(var key in userConfig){
					if(userConfig.hasOwnProperty(key) && typeof userConfig[key] !== 'undefined'){
						this.config[key] = userConfig[key];
					}
				}
			}
			// 切到 openai 服务
			translate.service.name = 'openai';
			// 启用整段翻译能力
			if(typeof translate.whole !== 'undefined' && translate.whole.enableAll){
				translate.whole.enableAll();
			}
			// 安装拦截 + changeLanguage hook（只装一次）
			if(!this._installed){
				this._installHook();
				this._installChangeLanguageHook();
				this._installed = true;
			}
			// 重置失败计数（用户重新激活视为重新开始）
			this.state.consecutiveFailures = 0;
			this._setMode('openai');
			// 启动 UI（齿轮 + 徽章）
			this.settingsUI.buildGearButton();
			this.statusBadge.build();
			this.statusBadge.setMode('openai');
			// 初始化缓存
			this.cache.init();
			// 加载缓存：优先当前语种，同时加载所有已有缓存文件（确保重启后立即命中）
			this.cache.loadFor(this._getCurrentTo());
			this.cache.loadAll();
			// 挂载关窗强制写入
			this._installCloseHandler();
			// 注册 translate.js 进度钩子（只注册一次）
			this._installProgressHooks();
			console.log('[translate.openai] 已激活，端点：' + (this.config.endpoint || '(未配置)') + '，模型：' + this.config.model);
		},

		// ===== 注册 translate.js 的渲染开始/结束钩子，用于进度显示 =====
		_installProgressHooks: function(){
			if(this._progressHooksInstalled) return;
			this._progressHooksInstalled = true;
			var self = this;
			// 翻译开始（某个语种开始调 API）
			if(typeof translate.listener !== 'undefined' && translate.listener.execute){
				if(typeof translate.listener.execute.renderStartByApi !== 'undefined'){
					translate.listener.execute.renderStartByApi.push(function(uuid, from, to){
						self._onTranslateStart(uuid, from, to);
					});
				}
				if(typeof translate.listener.execute.renderFinishByApi !== 'undefined'){
					translate.listener.execute.renderFinishByApi.push(function(uuid, from, to){
						self._onTranslateFinish(uuid, from, to);
					});
				}
			}
			// finally 兜底：translate.execute() 执行结束
			if(typeof translate.lifecycle !== 'undefined' && translate.lifecycle.execute && translate.lifecycle.execute.finally){
				translate.lifecycle.execute.finally.push(function(data){
					// state 25 = 已发起所有翻译请求（不等响应）；其他退出状态视为完成
					if(data && data.state !== 25 && data.state !== 1){
						self._onTranslateFinally();
					}
				});
			}
			console.log('[translate.openai] 进度钩子已注册');
		},

		// ===== 翻译开始回调 =====
		_onTranslateStart: function(uuid, from, to){
			this.state.activeRequests = (this.state.activeRequests || 0) + 1;
			this.statusBadge.setTranslating(true);
			console.log('[translate.openai] 翻译开始 (活跃请求: ' + this.state.activeRequests + ')');
		},

		// ===== 翻译完成回调 =====
		_onTranslateFinish: function(uuid, from, to){
			this.state.activeRequests = Math.max(0, (this.state.activeRequests || 0) - 1);
			if(this.state.activeRequests === 0){
				this.statusBadge.setTranslating(false);
				this.statusBadge.showCompleted();
			}
			console.log('[translate.openai] 翻译完成 (活跃请求: ' + this.state.activeRequests + ')');
		},

		// ===== finally 兜底 =====
		_onTranslateFinally: function(){
			// 如果 finally 触发但 activeRequests 还有，说明有异常，强制归零
			if(this.state.activeRequests > 0){
				console.warn('[translate.openai] finally 兜底：强制归零活跃请求 (' + this.state.activeRequests + ')');
				this.state.activeRequests = 0;
				this.statusBadge.setTranslating(false);
			}
		},

		// ===== 关闭大模型，切到 Edge =====
		disable: function(){
			this.config.enabled = false;
			translate.service.name = 'client.edge';
			this.statusBadge.setMode('disabled');
			this.statusBadge.setTranslating(false);
			console.log('[translate.openai] 大模型翻译已关闭，切换到 Edge 原生翻译');
		},

		// ===== 重新开启大模型 =====
		enable: function(){
			this.config.enabled = true;
			translate.service.name = 'openai';
			this.state.consecutiveFailures = 0;
			this.statusBadge.setMode('openai');
			console.log('[translate.openai] 大模型翻译已重新开启');
		},

		// ===== 重新翻译本页 =====
		retranslateCurrentPage: function(){
			var self = this;
			var to = translate.to || this._getCurrentTo();
			if(!to){
				console.warn('[translate.openai] 无法重新翻译：未设置目标语种');
				alert('请先选择翻译目标语言');
				return;
			}
			console.log('[translate.openai] 开始重新翻译本页，目标语种：' + to);
			// 保存当前 to（reset 会清掉）
			var savedTo = to;
			// 用 translate.reset() 将页面恢复到原文
			translate.reset({
				selectLanguageRefreshRender: false, // 不刷新 select 下拉
				notTranslateTip: true
			});
			// reset 清掉了 to，恢复
			translate.to = savedTo;
			translate.storage.set('to', savedTo);
			// 重新执行翻译
			// 给 DOM 一点时间恢复原文
			setTimeout(function(){
				translate.execute();
				console.log('[translate.openai] 重新翻译已触发');
			}, 300);
		},

		// ===== 更新翻译批次进度（translate() 主函数调用）=====
		_updateProgress: function(done, total){
			this.statusBadge.updateProgress(done, total);
		},

		// ===== 获取当前目标语种 =====
		_getCurrentTo: function(){
			// 优先用 translate.to，其次 localStorage 里存的 to，最后默认简体中文
			var to = translate.to;
			if(!to){
				try{ to = localStorage.getItem('to'); }catch(e){}
			}
			if(!to) to = 'chinese_simplified';
			return to;
		},

		// ===== 安装 monkey-patch 拦截 =====
		_installHook: function(){
			var self = this;
			var _origPost = translate.request.post;
			translate.request.post = function(path, data, func, abnormalFunc){
				if(translate.service.name !== 'openai'){
					return _origPost.apply(this, arguments);
				}
				// 翻译请求
				if(path === translate.request.api.translate){
					self.translate(path, data, func, abnormalFunc);
					return;
				}
				// 语种列表
				if(path === translate.request.api.language){
					func({result:1, info:'SUCCESS', list: self.language.json});
					return;
				}
				// init / connectTest / ip 这些请求在 openai 模式下直接忽略
				if(path === translate.request.api.init || path === translate.request.api.connectTest || path === translate.request.api.ip){
					return;
				}
				// 其他未知请求走原逻辑
				return _origPost.apply(this, arguments);
			};
			console.log('[translate.openai] 拦截已安装');
		},

		// ===== monkey-patch translate.changeLanguage 切语言时重载缓存 =====
		_installChangeLanguageHook: function(){
			var self = this;
			if(translate._origChangeLanguage) return; // 已安装
			translate._origChangeLanguage = translate.changeLanguage;
			translate.changeLanguage = function(languageName){
				var r = translate._origChangeLanguage.apply(this, arguments);
				// 切换语言后加载新语种缓存
				try{
					self.cache.loadFor(languageName);
					console.log('[translate.openai] 切换语言至 ' + languageName + '，已加载对应缓存');
				}catch(e){
					console.warn('[translate.openai] 切换语言时加载缓存失败', e);
				}
				return r;
			};
		},

		// ===== 挂载关窗强制 flush =====
		_installCloseHandler: function(){
			if(this._closeHandlerInstalled) return;
			var self = this;
			this._closeHandlerInstalled = true;
			// beforeunload 兜底
			window.addEventListener('beforeunload', function(){
				try{ self.cache.flushSync(); }catch(e){}
			});
			// Electron 窗口 close 事件（更可靠）
			try{
				if(typeof require === 'function'){
					var remote = null;
					try{ remote = require('@electron/remote'); }catch(e){}
					if(!remote){
						try{ remote = require('electron').remote; }catch(e){}
					}
					if(remote && remote.getCurrentWindow){
						remote.getCurrentWindow().on('close', function(){
							try{ self.cache.flushSync(); }catch(e){}
						});
						console.log('[translate.openai] 已挂载 Electron close 事件');
					}
				}
			}catch(e){
				console.warn('[translate.openai] 挂载 Electron close 事件失败，仅用 beforeunload', e);
			}
		},

		// ===== 批量翻译主函数 =====
		translate: function(path, data, func, abnormalFunc){
			var self = this;
			var textArray;
			try{
				textArray = JSON.parse(decodeURIComponent(data.text));
			}catch(e){
				console.error('[translate.openai] 解析 text 失败', e);
				if(abnormalFunc) abnormalFunc({status:0, responseText:'parse error'});
				return;
			}
			var from = data.from;
			var to = data.to;
			var fromName = this.language.map[from] || from;
			var toName = this.language.map[to] || to;

			// 结果数组，按原下标填充（未完成的为 undefined）
			var results = new Array(textArray.length);

			// ===== 自适应分批：按字符长度切批，避免长文本挤一批 =====
			var pendingBatches = [];
			var curBatch = [];
			var curChars = 0;
			var curStart = 0;
			for(var i=0; i<textArray.length; i++){
				var tLen = String(textArray[i]).length;
				// 如果当前批已达条数上限或字符上限，封批
				if(curBatch.length >= this.config.batchSize || (curBatch.length > 0 && curChars + tLen > this.config.batchCharLimit)){
					pendingBatches.push({startIndex:curStart, texts:curBatch});
					curBatch = [];
					curChars = 0;
					curStart = i;
				}
				curBatch.push(textArray[i]);
				curChars += tLen;
			}
			if(curBatch.length > 0){
				pendingBatches.push({startIndex:curStart, texts:curBatch});
			}

			var totalBatches = pendingBatches.length;
			var completedBatches = 0;
			var finalCallbackFired = false;
			console.log('[translate.openai] 翻译请求开始，共 ' + textArray.length + ' 条文本，自适应分 ' + totalBatches + ' 批，并行上限 ' + this.config.maxConcurrency + (this.config.progressiveOutput ? '，渐进式输出已开启' : ''));

			// ===== 渐进式回调：用当前 results 构造输出数组（未完成的为 null）=====
			function buildOutputArray(){
				var out = new Array(results.length);
				for(var i=0; i<results.length; i++){
					out[i] = (typeof results[i] === 'string') ? results[i] : null;
				}
				return out;
			}

			// ===== 全部完成后的收尾 =====
			function finalFinish(){
				if(finalCallbackFired) return;
				finalCallbackFired = true;
				var missing = 0;
				for(var m=0; m<results.length; m++){
					if(typeof results[m] !== 'string'){
						results[m] = textArray[m]; // 失败的回退原文
						missing++;
					}
				}
				if(missing > 0){
					console.warn('[translate.openai] 有 ' + missing + ' 条文本翻译失败，已回退原文');
				}
				self.state.stats.totalRequests++;
				self.state.stats.successCount++;
				// 最终回调：完整 results（无 null），translate.js 只收到这一次回调
				func({result:1, info:'SUCCESS', from:from, to:to, text:results});
				// 确保缓存写盘
				try{ self.cache.flush(); }catch(e){ console.warn('[translate.openai] 最终 flush 失败', e); }
			}

			// ===== 渐进式输出：某批完成时立即输出当前进度 =====
			// 注意：只能调一次 func，否则 translate.js 会误判翻译完成。
			// 渐进式模式下，中间批次用 info:'PROGRESSIVE' 标记，translate.js 的 result!=1 判断会走错误分支，
			// 但那条分支不会渲染——所以渐进式实际不工作，默认关闭。
			// 真正的加速靠并行 + 自适应分批，不靠渐进式。
			function progressiveEmit(){
				if(!self.config.progressiveOutput) return;
				if(finalCallbackFired) return;
				var out = buildOutputArray();
				var doneCount = 0;
				for(var d=0; d<out.length; d++){ if(out[d] !== null) doneCount++; }
				console.log('[translate.openai] 渐进式输出：已完成 ' + doneCount + '/' + out.length + ' 条');
				func({result:1, info:'PROGRESSIVE', from:from, to:to, text:out});
			}

			// ===== 并发池 =====
			var pool = [];       // 正在飞的 Promise
			var queueIndex = 0;  // 下一个要取的批下标

			function scheduleNext(){
				while(pool.length < self.config.maxConcurrency && queueIndex < pendingBatches.length){
					var batch = pendingBatches[queueIndex++];
					(function(batch){
						var p = self._translateBatch(batch, fromName, toName, textArray)
							.then(function(translated){
								for(var t=0; t<translated.length; t++){
									results[batch.startIndex + t] = translated[t];
									// 每条翻译完成就立即记录到缓存（不等 finalFinish，防丢失）
									if(translated[t] !== batch.texts[t]){
										try{
											var h = translate.util.hash(batch.texts[t]);
											self.cache.record(h, translated[t], to);
										}catch(e){}
									}
								}
							completedBatches++;
							console.log('[translate.openai] 批次 ' + completedBatches + '/' + totalBatches + ' 完成（' + batch.texts.length + ' 条）');
							self._updateProgress(completedBatches, totalBatches);
							progressiveEmit();
						})
						.catch(function(err){
							completedBatches++;
							console.error('[translate.openai] 批次失败 startIndex=' + batch.startIndex, err);
							self._recordFailure(err);
							self._updateProgress(completedBatches, totalBatches);
							progressiveEmit();
						});
						pool.push(p);
						p.then(function(){ removeDone(p); }, function(){ removeDone(p); });
					})(batch);
				}
				if(completedBatches >= totalBatches){
					finalFinish();
				}
			}
			function removeDone(p){
				var idx = pool.indexOf(p);
				if(idx > -1) pool.splice(idx,1);
				scheduleNext();
			}
			scheduleNext();
		},

	// ===== 翻译单批（返回 Promise<字符串数组>）=====
	_translateBatch: function(batch, fromName, toName, fullTextArray){
		var self = this;
		var sep = this.config.separator;
		// 对原文中可能出现的分隔符做转义
		var texts = batch.texts.map(function(t){
			return String(t).split(sep).join(sep.replace(/[-\/\\^$*+?.()|[\]{}]/g,''));
		});
		var content = texts.join(sep);
		// 构造上下文片段
		var contextStr = self._buildContext(batch, fullTextArray);
		var prompt = self._buildPrompt(texts, fromName, toName, contextStr, content, false);

		return self._callOpenAI(prompt)
			.then(function(replyText){
				// 解析回复
				var parts = self._parseReply(replyText, sep, texts.length);
				if(parts !== null && parts.length === texts.length){
					return parts;
				}
				// 格式异常，尝试自动修复切分
				if(parts !== null){
					var fixed = self._autoFixSplit(parts, texts.length, replyText, sep);
					if(fixed !== null){
						console.log('[translate.openai] 批次格式自动修复成功（' + parts.length + '→' + fixed.length + ' 条）');
						return fixed;
					}
				}
				// 修复失败 → 重试一次（更严格提示词）
				if(self.config.retryOnFormatError){
					console.warn('[translate.openai] 批次格式异常，用严格提示词重试一次');
					var strictPrompt = self._buildPrompt(texts, fromName, toName, contextStr, content, true);
					return self._callOpenAI(strictPrompt).then(function(reply2){
						var parts2 = self._parseReply(reply2, sep, texts.length);
						if(parts2 !== null){
							if(parts2.length === texts.length) return parts2;
							var fixed2 = self._autoFixSplit(parts2, texts.length, reply2, sep);
							if(fixed2 !== null){
								console.log('[translate.openai] 重试后自动修复成功');
								return fixed2;
							}
						}
						// 仍失败 → 降级
						console.warn('[translate.openai] 重试仍失败，降级逐条翻译');
						self.state.stats.batchDegradedCount++;
						return self._translateOneByOne(texts, fromName, toName, batch, fullTextArray);
					});
				}
				// 不重试，直接降级
				console.warn('[translate.openai] 批次格式异常：降级逐条翻译');
				self.state.stats.batchDegradedCount++;
				return self._translateOneByOne(texts, fromName, toName, batch, fullTextArray);
			});
	},

	// ===== 构造输出格式指令（注入 {outputFormat} 占位符）=====
	_buildOutputFormatInstruction: function(useStrict){
		var sep = this.config.separator;
		if(this.config.outputFormat === 'json'){
			if(useStrict){
				return '以 JSON 数组格式返回译文，格式严格为 ["译文1","译文2",...]，数组元素个数必须等于原文条数，不要包含任何其他文字、代码块标记或解释。';
			}
			return '以 JSON 数组格式返回译文，格式为 ["译文1","译文2",...]，数组元素个数等于原文条数。';
		}else{
			if(useStrict){
				return '用分隔符 ' + JSON.stringify(sep) + ' 分隔各条译文，分隔符前后不得增减，只输出译文，不要任何其他文字、代码块标记或解释。';
			}
			return '用分隔符 ' + JSON.stringify(sep) + ' 分隔各条译文。';
		}
	},

	// ===== 构造完整提示词 =====
	_buildPrompt: function(texts, fromName, toName, contextStr, content, useStrict){
		var sep = this.config.separator;
		var prompt = this.config.promptTemplate
			.replace(/\{scene\}/g, this.config.scene)
			.replace(/\{from\}/g, fromName)
			.replace(/\{to\}/g, toName)
			.replace(/\{sep\}/g, sep)
			.replace(/\{context\}/g, contextStr)
			.replace(/\{outputFormat\}/g, this._buildOutputFormatInstruction(useStrict))
			.replace(/\{content\}/g, content);
		if(useStrict){
			// 在提示词末尾追加严格的最后警告
			prompt += '\n\n【重要】上次返回格式不正确。请严格遵守：只输出' + (this.config.outputFormat === 'json' ? 'JSON 数组' : '分隔符分隔的译文') + '，恰好 ' + texts.length + ' 条，不要任何其他内容。';
		}
		return prompt;
	},

	// ===== 解析模型回复（返回字符串数组或 null）=====
	_parseReply: function(replyText, sep, expectedCount){
		if(typeof replyText !== 'string') return null;
		var raw = replyText.trim();
		if(this.config.outputFormat === 'json'){
			// JSON 模式
			var json = this._extractJSON(raw);
			if(json !== null && Array.isArray(json)){
				// 全部转字符串
				var arr = json.map(function(x){ return String(x); });
				return arr;
			}
			// JSON 解析失败，尝试用分隔符兜底解析（兼容模型偶尔不遵守 JSON 格式）
			var parts = this._splitBySeparator(raw, sep);
			return parts;
		}else{
			// 分隔符模式
			var parts = this._splitBySeparator(raw, sep);
			return parts;
		}
	},

	// ===== 从文本中提取 JSON 数组（容错：去代码块、找第一个 [ 到匹配 ] ）=====
	_extractJSON: function(text){
		if(typeof text !== 'string') return null;
		var t = text.trim();
		// 去除 ``` 代码块包裹
		t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'');
		// 直接尝试 parse
		try{
			var v = JSON.parse(t);
			if(Array.isArray(v)) return v;
		}catch(e){}
		// 找第一个 [ 到最后一个 ] 之间截取再试
		var start = t.indexOf('[');
		var end = t.lastIndexOf(']');
		if(start >= 0 && end > start){
			var sub = t.substring(start, end+1);
			try{
				var v2 = JSON.parse(sub);
				if(Array.isArray(v2)) return v2;
			}catch(e2){}
		}
		return null;
	},

	// ===== 自动修复切分（返回修正后的数组或 null）=====
	// parts: 初步切分的结果；expected: 期望条数；rawText: 原始回复
	_autoFixSplit: function(parts, expected, rawText, sep){
		if(!Array.isArray(parts)) return null;
		// 去除每条首尾空白
		var arr = parts.map(function(p){ return String(p).trim(); });
		// 去除首尾空串
		while(arr.length > 0 && arr[0] === '') arr.shift();
		while(arr.length > 0 && arr[arr.length-1] === '') arr.pop();
		if(arr.length === expected) return arr;
		// 去除常见说明性首项（含冒号、含"翻译"、含"Here"/"Sure"等）
		var firstItemFixes = [
			/^(好的|当然|没问题|sure|here|below|翻译如下|以下是|译文如下)[：:。\s]*$/i,
			/^(好的|当然)[，,]?\s*(翻译如下|以下是)[：:。\s]*$/i,
			/^(here is|below is|sure,?\s*here)[^\n]*$/i
		];
		if(arr.length === expected + 1){
			for(var i=0; i<firstItemFixes.length; i++){
				if(firstItemFixes[i].test(arr[0])){
					var candidate = arr.slice(1);
					while(candidate.length > 0 && candidate[0] === '') candidate.shift();
					if(candidate.length === expected) return candidate;
				}
			}
		}
		// 去除常见说明性尾项
		var lastItemFixes = [
			/^(希望|以上|备注|说明|note|hope)[^\n]*$/i
		];
		if(arr.length === expected + 1){
			for(var j=0; j<lastItemFixes.length; j++){
				if(lastItemFixes[j].test(arr[arr.length-1])){
					var candidate2 = arr.slice(0, arr.length-1);
					while(candidate2.length > 0 && candidate2[candidate2.length-1] === '') candidate2.pop();
					if(candidate2.length === expected) return candidate2;
				}
			}
		}
		// 合并相邻空串（多个分隔符连在一起导致空条目）
		if(arr.length > expected){
			var merged = [];
			var emptyRun = 0;
			for(var k=0; k<arr.length; k++){
				if(arr[k] === ''){
					emptyRun++;
					if(emptyRun > 1) continue; // 跳过连续空串
				}else{
					emptyRun = 0;
				}
				merged.push(arr[k]);
			}
			if(merged.length === expected) return merged;
		}
		return null;
	},

	// ===== 构造上下文字符串（带编号列表）=====
	// 返回值末尾自带换行，若空则返回空字符串（提示词中 {context} 直接被替换为空）
	_buildContext: function(batch, fullTextArray){
		if(!this.config.contextEnabled) return '';
		if(!fullTextArray || fullTextArray.length === 0) return '';

		var limit = this.config.contextLimit;
		var windowSize = this.config.contextWindow;
		var startIndex = batch.startIndex;
		var batchLen = batch.texts.length;
		var totalLen = fullTextArray.length;

		// 计算全量上下文的字符数
		var totalChars = 0;
		for(var i=0; i<totalLen; i++){
			totalChars += String(fullTextArray[i]).length;
		}

		var contextItems = [];  // [{index, text}]
		if(totalChars <= limit){
			// 全量上下文：所有条目
			for(var i=0; i<totalLen; i++){
				// 跳过当前批（避免与任务区重复）
				if(i >= startIndex && i < startIndex + batchLen) continue;
				contextItems.push({index:i+1, text:String(fullTextArray[i])});
			}
		}else{
			// 超限：取当前批前后各 windowSize 条
			var beforeStart = Math.max(0, startIndex - windowSize);
			var beforeEnd = startIndex;  // 不含当前批
			for(var i=beforeStart; i<beforeEnd; i++){
				contextItems.push({index:i+1, text:String(fullTextArray[i])});
			}
			var afterStart = startIndex + batchLen;  // 当前批之后
			var afterEnd = Math.min(totalLen, afterStart + windowSize);
			for(var i=afterStart; i<afterEnd; i++){
				contextItems.push({index:i+1, text:String(fullTextArray[i])});
			}
		}

		if(contextItems.length === 0) return '';

		// 构造带编号列表，如：
		// 【页面上下文】以下是同一场景的其它文本，帮助你理解整体语境（不要翻译这部分）：
		// [1] She
		// [2] walked over
		// ...
		var lines = ['【页面上下文】以下是同一场景的其它文本，帮助你理解整体语境（不要翻译这部分，仅用于参考）：\n'];
		for(var i=0; i<contextItems.length; i++){
			var item = contextItems[i];
			// 单条过长截断（防一条巨长文本撑爆上下文）
			var txt = item.text;
			if(txt.length > 200) txt = txt.substring(0,200) + '...';
			lines.push('[' + item.index + '] ' + txt + '\n');
		}
		lines.push('\n');
		return lines.join('');
	},

	// ===== 逐条翻译（并行降级，保证条数一致）=====
	_translateOneByOne: function(texts, fromName, toName, batch, fullTextArray){
		var self = this;
		var results = new Array(texts.length);
		var contextStr = self._buildContext(batch, fullTextArray);

		if(self.config.degradeParallel){
			// 并行降级：所有条目同时飞，受 maxConcurrency 控制
			console.log('[translate.openai] 并行降级逐条翻译，共 ' + texts.length + ' 条，并发上限 ' + self.config.maxConcurrency);
			var pool = [];
			var queueIndex = 0;
			function schedule(){
				while(pool.length < self.config.maxConcurrency && queueIndex < texts.length){
					(function(idx){
						var singleContent = String(texts[idx]);
						var prompt = self._buildPrompt([texts[idx]], fromName, toName, contextStr, singleContent, false);
						var p = self._callOpenAI(prompt).then(function(reply){
							results[idx] = reply.trim();
						}).catch(function(err){
							console.error('[translate.openai] 逐条翻译失败 idx=' + idx, err);
							results[idx] = texts[idx];
						});
						pool.push(p);
						queueIndex++;
						p.then(function(){ removeDone(p); }, function(){ removeDone(p); });
					})(queueIndex);
				}
			}
			function removeDone(p){
				var i = pool.indexOf(p);
				if(i > -1) pool.splice(i,1);
				if(queueIndex < texts.length || pool.length > 0){
					schedule();
				}
			}
			schedule();
			// 等所有完成
			return new Promise(function(resolve){
				var checkTimer = setInterval(function(){
					if(queueIndex >= texts.length && pool.length === 0){
						clearInterval(checkTimer);
						// 补全未填充的（理论上不会，但兜底）
						for(var i=0; i<results.length; i++){
							if(typeof results[i] !== 'string') results[i] = texts[i];
						}
						resolve(results);
					}
				}, 100);
			});
		}else{
			// 串行降级（旧逻辑，兼容）
			var chain = Promise.resolve();
			texts.forEach(function(t, idx){
				chain = chain.then(function(){
					var singleContent = String(t);
					var prompt = self._buildPrompt([t], fromName, toName, contextStr, singleContent, false);
					return self._callOpenAI(prompt).then(function(reply){
						results[idx] = reply.trim();
					}).catch(function(err){
						console.error('[translate.openai] 逐条翻译失败 idx=' + idx, err);
						results[idx] = texts[idx];
					});
				});
			});
			return chain.then(function(){ return results; });
		}
	},

		// ===== 调用 OpenAI 兼容接口（返回 Promise<string>)=====
		_callOpenAI: function(prompt){
			var self = this;
			return new Promise(function(resolve, reject){
				var cfg = self.config;
				if(!cfg.endpoint || !cfg.apiKey){
					reject(new Error('endpoint 或 apiKey 未配置'));
					return;
				}
				var body = JSON.stringify({
					model: cfg.model,
					messages: [
						{role:'system', content:'You are a professional translation engine. Follow the instructions exactly.'},
						{role:'user', content:prompt}
					],
					temperature: cfg.temperature,
					stream: false
				});
				var startedAt = Date.now();
				self._httpRequest(cfg.endpoint, body, cfg.apiKey, cfg.requestTimeout)
					.then(function(respText){
						try{
							var resp = JSON.parse(respText);
							if(resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content){
								var content = resp.choices[0].message.content;
								var elapsed = Date.now() - startedAt;
								console.log('[translate.openai] API 响应耗时 ' + elapsed + 'ms');
								self._recordSuccess();
								resolve(content);
							}else{
								reject(new Error('响应格式异常：' + respText.substring(0,200)));
							}
						}catch(e){
							reject(new Error('响应解析失败：' + e.message + ' resp=' + respText.substring(0,200)));
						}
					})
					.catch(function(err){
						reject(err);
					});
			});
		},

		// ===== HTTP 请求（优先 Node https，规避 CORS；降级 fetch）=====
		_httpRequest: function(url, body, apiKey, timeoutMs){
			return new Promise(function(resolve, reject){
				// 优先 Node https/http（Electron nodeIntegration:true）
				var useNode = false;
				try{
					if(typeof require === 'function' && typeof process !== 'undefined' && process.versions && process.versions.electron){
						useNode = true;
					}
				}catch(e){}

				if(useNode){
					try{
						var parsed = require('url').parse(url);
						var httpMod = parsed.protocol === 'https:' ? require('https') : require('http');
						var req = httpMod.request({
							hostname: parsed.hostname,
							port: parsed.port,
							path: parsed.path,
							method: 'POST',
							headers: {
								'Content-Type':'application/json',
								'Authorization':'Bearer ' + apiKey,
								'Content-Length': Buffer.byteLength(body)
							},
							timeout: timeoutMs
						}, function(res){
							var chunks = [];
							res.on('data', function(c){ chunks.push(c); });
							res.on('end', function(){
								var respText = Buffer.concat(chunks).toString('utf8');
								if(res.statusCode >= 200 && res.statusCode < 300){
									resolve(respText);
								}else{
									var err = new Error('HTTP ' + res.statusCode + ': ' + respText.substring(0,300));
									err.statusCode = res.statusCode;
									reject(err);
								}
							});
						});
						req.on('error', function(e){ reject(e); });
						req.on('timeout', function(){
							req.destroy(new Error('请求超时 ' + timeoutMs + 'ms'));
						});
						req.write(body);
						req.end();
						return;
					}catch(e){
						console.warn('[translate.openai] Node http 模块异常，降级 fetch', e);
					}
				}

				// 降级 fetch
				if(typeof fetch === 'function'){
					var controller = (typeof AbortController === 'function') ? new AbortController() : null;
					var timer = controller ? setTimeout(function(){ controller.abort(); }, timeoutMs) : null;
					fetch(url, {
						method:'POST',
						headers:{'Content-Type':'application/json','Authorization':'Bearer '+apiKey},
						body:body,
						signal: controller ? controller.signal : undefined
					}).then(function(r){
						if(timer) clearTimeout(timer);
						return r.text().then(function(txt){
							if(r.ok){ resolve(txt); }
							else{ var e=new Error('HTTP '+r.status+': '+txt.substring(0,300)); e.statusCode=r.status; throw e; }
						});
					}).catch(function(e){ if(timer) clearTimeout(timer); reject(e); });
				}else{
					reject(new Error('无可用的网络请求方式（Node https 与 fetch 均不可用）'));
				}
			});
		},

		// ===== 按分隔符切分（转义安全）=====
		_splitBySeparator: function(text, sep){
			if(typeof text !== 'string') return [];
			// 简单 split 即可，分隔符本身不含正则元字符时直接用
			var parts = text.split(sep);
			// 去除每个 part 首尾空白
			for(var i=0; i<parts.length; i++){
				parts[i] = parts[i].replace(/^\n+/, '').replace(/\n+$/, '');
			}
			return parts;
		},

		// ===== 成功/失败记录 =====
		_recordSuccess: function(){
			this.state.consecutiveFailures = 0;
		},
		_recordFailure: function(err){
			this.state.consecutiveFailures++;
			this.state.stats.failedCount++;
			var code = (err && err.statusCode) ? err.statusCode : 0;
			console.warn('[translate.openai] 请求失败 #' + this.state.consecutiveFailures + '/' + this.config.degradeThreshold + (code?(' (HTTP '+code+')'):'') + '：' + (err && err.message ? err.message : err));
			// 401/403 立即降级
			if(code === 401 || code === 403){
				this._degradeToEdge('API Key 无效 (HTTP ' + code + ')');
				return;
			}
			if(this.state.consecutiveFailures >= this.config.degradeThreshold){
				this._degradeToEdge('连续 ' + this.state.consecutiveFailures + ' 次请求失败');
			}
		},

		// ===== 降级到 Edge =====
		_degradeToEdge: function(reason){
			if(this.state.mode === 'degraded') return; // 已降级
			this.state.mode = 'degraded';
			this.state.lastDegradedAt = Date.now();
			this.state.degradeReason = reason;
			// 切到 Edge
			translate.service.name = 'client.edge';
			this.statusBadge.setMode('degraded');
			console.error('[translate.openai] ⚠ 已降级到 Edge 浏览器翻译，原因：' + reason + '，翻译质量将下降。每 ' + (this.config.autoRecoverInterval/1000) + ' 秒自动探测恢复。');
			// 启动恢复探测
			this._startRecoverProbe();
		},

		// ===== 启动恢复探测 =====
		_startRecoverProbe: function(){
			var self = this;
			if(this.state.recoverTimer) return;
			var probeCount = 0;
			this.state.recoverTimer = setInterval(function(){
				if(self.state.mode !== 'degraded'){
					self._stopRecoverProbe();
					return;
				}
				probeCount++;
				console.log('[translate.openai] 恢复探测 #' + probeCount + ' ...');
				self._tryRecover(probeCount);
			}, this.config.autoRecoverInterval);
		},
		_stopRecoverProbe: function(){
			if(this.state.recoverTimer){
				clearInterval(this.state.recoverTimer);
				this.state.recoverTimer = null;
			}
		},

		// ===== 探测恢复 =====
		_tryRecover: function(probeCount){
			var self = this;
			// 用最小请求测试
			var prompt = self.config.promptTemplate
				.replace(/\{scene\}/g, self.config.scene)
				.replace(/\{from\}/g, 'English')
				.replace(/\{to\}/g, '简体中文')
				.replace(/\{sep\}/g, self.config.separator)
				.replace(/\{context\}/g, '')
				.replace(/\{outputFormat\}/g, self._buildOutputFormatInstruction(false))
				.replace(/\{content\}/g, 'Hello');
			self._callOpenAI(prompt).then(function(){
				// 成功，恢复
				self.state.mode = 'openai';
				self.state.lastRecoveredAt = Date.now();
				self.state.consecutiveFailures = 0;
				translate.service.name = 'openai';
				self.statusBadge.setMode('openai');
				self._stopRecoverProbe();
				console.log('[translate.openai] ✅ 已恢复大模型翻译（探测 #' + probeCount + ' 成功）');
			}).catch(function(err){
				console.log('[translate.openai] 恢复探测 #' + probeCount + ' 失败：' + (err && err.message ? err.message : err));
			});
		},

		// ===== 设置模式（不触发降级/恢复逻辑）=====
		_setMode: function(mode){
			this.state.mode = mode;
			this.statusBadge.setMode(mode);
		},

		// ===== 设置 UI =====
		settingsUI: {
			gearButton: null,
			modal: null,

		buildGearButton: function(){
			if(this.gearButton) return;
			var btn = document.createElement('div');
			btn.id = 'translate-openai-gear';
			btn.setAttribute('class','ignore translate-openai-gear');
			btn.innerHTML = '⚙';
			btn.title = '翻译设置';
			btn.style.cssText = 'position:fixed;right:20px;bottom:20px;width:36px;height:36px;line-height:36px;text-align:center;font-size:20px;cursor:pointer;background:rgba(0,0,0,0.5);color:#fff;border-radius:50%;z-index:2147483647;user-select:none;font-family:sans-serif;';
			var self = this;
			btn.addEventListener('click', function(){ self.show(); });
			document.body.appendChild(btn);
			this.gearButton = btn;
			// 同时创建"重新翻译本页"按钮
			this.buildRetranslateButton();
		},

		// ===== 重新翻译本页按钮 =====
		buildRetranslateButton: function(){
			if(this.retranslateBtn) return;
			var btn = document.createElement('div');
			btn.id = 'translate-openai-retranslate';
			btn.setAttribute('class','ignore translate-openai-retranslate');
			btn.innerHTML = '🔄';
			btn.title = '重新翻译本页（清除本页翻译缓存后重新翻译）';
			btn.style.cssText = 'position:fixed;right:62px;bottom:20px;width:36px;height:36px;line-height:36px;text-align:center;font-size:18px;cursor:pointer;background:rgba(0,0,0,0.5);color:#fff;border-radius:50%;z-index:2147483647;user-select:none;font-family:sans-serif;display:flex;align-items:center;justify-content:center;transition:transform 0.3s ease,background 0.3s ease;';
			btn.addEventListener('mouseenter', function(){ btn.style.background = 'rgba(40,167,69,0.7)'; btn.style.transform = 'scale(1.1)'; });
			btn.addEventListener('mouseleave', function(){ btn.style.background = 'rgba(0,0,0,0.5)'; btn.style.transform = 'scale(1)'; });
			btn.addEventListener('click', function(){ translate.service.openai.retranslateCurrentPage(); });
			document.body.appendChild(btn);
			this.retranslateBtn = btn;
		},

		show: function(){
				if(this.modal){ this.modal.style.display = 'block'; this.refreshCacheStats(); return; }
				this.buildModal();
				this.modal.style.display = 'block';
				this.load();
				this.loadIntoForm();
				this.refreshCacheStats();
			},

			hide: function(){
				if(this.modal) this.modal.style.display = 'none';
			},

			// ===== 刷新缓存统计显示 =====
			refreshCacheStats: function(){
				var el = document.getElementById('toa-cache-stats');
				if(!el) return;
				var cache = translate.service.openai.cache;
				var count = cache.count();
				var size = cache.size();
				var sizeStr = size > 0 ? (size < 1024 ? size + ' B' : (size < 1048576 ? (size/1024).toFixed(1) + ' KB' : (size/1048576).toFixed(2) + ' MB')) : '0 B';
				el.textContent = '已缓存翻译：' + count.toLocaleString() + ' 条 / 占用 ' + sizeStr + '（语种：' + (cache.currentTo || '-') + '）';
			},

			buildModal: function(){
				var self = this;
				var modal = document.createElement('div');
				modal.id = 'translate-openai-modal';
				modal.setAttribute('class','ignore');
				modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:2147483647;display:none;font-family:sans-serif;';
			modal.innerHTML =
				'<div style="background:#fff;width:560px;max-height:90vh;overflow-y:auto;margin:40px auto;border-radius:8px;padding:24px;box-shadow:0 4px 20px rgba(0,0,0,0.3);color:#333;">' +
					'<h2 style="margin:0 0 16px 0;font-size:20px;color:#333;">翻译设置 (OpenAI 兼容 API)</h2>' +
					'<div style="margin-bottom:16px;padding:14px 16px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:8px;color:#fff;">' +
						'<label style="display:flex;align-items:center;cursor:pointer;font-size:15px;font-weight:bold;">' +
							'<input id="toa-enabled" type="checkbox" checked style="margin-right:10px;width:18px;height:18px;cursor:pointer;">' +
							'启用大模型翻译</label>' +
						'<div style="font-size:12px;margin-top:6px;opacity:0.9;">关闭后使用 Edge 浏览器原生翻译，配置保留不丢失，随时可重新开启。</div>' +
					'</div>' +
					'<div id="toa-config-area">' +
					'<div style="margin-bottom:12px;"><label style="display:block;font-size:13px;color:#666;margin-bottom:4px;">API 端点 Endpoint</label>' +
						'<input id="toa-endpoint" type="text" placeholder="https://api.deepseek.com/v1/chat/completions" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;font-size:14px;"></div>' +
						'<div style="margin-bottom:12px;"><label style="display:block;font-size:13px;color:#666;margin-bottom:4px;">API Key</label>' +
							'<input id="toa-apikey" type="password" placeholder="sk-..." style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;font-size:14px;"></div>' +
						'<div style="margin-bottom:12px;"><label style="display:block;font-size:13px;color:#666;margin-bottom:4px;">模型 Model</label>' +
							'<input id="toa-model" type="text" placeholder="deepseek-chat" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;font-size:14px;"></div>' +
						'<div style="display:flex;gap:12px;margin-bottom:12px;">' +
							'<div style="flex:1;"><label style="display:block;font-size:13px;color:#666;margin-bottom:4px;">每批条数上限</label>' +
								'<input id="toa-batchsize" type="number" value="10" min="1" max="200" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;font-size:14px;"></div>' +
							'<div style="flex:1;"><label style="display:block;font-size:13px;color:#666;margin-bottom:4px;">每批字符上限</label>' +
								'<input id="toa-batchcharlimit" type="number" value="1000" min="500" max="50000" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;font-size:14px;"></div>' +
							'<div style="flex:1;"><label style="display:block;font-size:13px;color:#666;margin-bottom:4px;">并发上限</label>' +
								'<input id="toa-concurrency" type="number" value="5" min="1" max="20" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;font-size:14px;"></div>' +
						'</div>' +
					'<div style="margin-bottom:12px;"><label style="display:block;font-size:13px;color:#666;margin-bottom:4px;">输出格式</label>' +
						'<select id="toa-output-format" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;font-size:14px;">' +
							'<option value="json">JSON 数组（推荐，格式稳定，支持大批量）</option>' +
							'<option value="separator">分隔符（兼容旧模型，批量小）</option>' +
						'</select>' +
						'<div style="font-size:11px;color:#999;margin-top:4px;">JSON 模式几乎不会格式异常，可放心用大批量；分隔符模式对老模型更兼容。</div></div>' +
					'<div style="margin-bottom:12px;padding:10px 12px;background:#fff3cd;border-radius:4px;border:1px solid #ffeaa7;">' +
						'<label style="display:flex;align-items:center;font-size:13px;color:#856404;cursor:pointer;">' +
							'<input id="toa-progressive" type="checkbox" style="margin-right:8px;">渐进式输出（实验性，默认关，可能显示不完整）</label>' +
						'<div style="font-size:11px;color:#997a04;margin-top:4px;">每批完成立即显示，但跟翻译引擎状态机有冲突，可能导致部分文本不显示。默认关闭，靠并行+自适应分批加速即可。</div>' +
					'</div>' +
				'<div style="margin-bottom:12px;"><label style="display:block;font-size:13px;color:#666;margin-bottom:4px;">翻译场景</label>' +
					'<input id="toa-scene" type="text" value="游戏文本翻译" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;font-size:14px;"></div>' +
				'<div style="margin-bottom:12px;"><label style="display:block;font-size:13px;color:#666;margin-bottom:4px;">温度 Temperature</label>' +
					'<input id="toa-temperature" type="number" value="0.6" min="0" max="2" step="0.1" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;font-size:14px;">' +
					'<div style="font-size:11px;color:#e8890c;margin-top:4px;">💡 建议 0.6，游戏文本推荐 0.5-0.7。值越高翻译越自由地道，越低越保守逐字。</div></div>' +
					'<div style="margin-bottom:12px;padding:12px;background:#f0f7ff;border-radius:4px;border:1px solid #cce0ff;">' +
						'<label style="display:flex;align-items:center;font-size:13px;color:#0066cc;cursor:pointer;margin-bottom:8px;">' +
							'<input id="toa-context-enabled" type="checkbox" checked style="margin-right:8px;">启用上下文增强翻译</label>' +
						'<div style="font-size:11px;color:#666;margin-bottom:8px;">将同场景其它文本作为上下文一并发给模型，提高翻译准确度。仅原文作为参考，不翻译。</div>' +
						'<div style="display:flex;gap:12px;">' +
							'<div style="flex:1;"><label style="display:block;font-size:12px;color:#666;margin-bottom:4px;">上下文字符上限</label>' +
								'<input id="toa-context-limit" type="number" value="300" min="0" max="50000" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;font-size:13px;"></div>' +
							'<div style="flex:1;"><label style="display:block;font-size:12px;color:#666;margin-bottom:4px;">超限时前后条数</label>' +
								'<input id="toa-context-window" type="number" value="5" min="0" max="100" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;font-size:13px;"></div>' +
						'</div>' +
					'</div>' +
					'<div style="margin-bottom:12px;"><div id="toa-adv-toggle" style="cursor:pointer;color:#0066cc;font-size:13px;">▶ 高级：自定义提示词</div>' +
						'<textarea id="toa-prompt" style="display:none;width:100%;height:120px;padding:8px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;font-size:12px;margin-top:8px;font-family:monospace;"></textarea></div>' +
					'<div style="margin-bottom:16px;"><button id="toa-test" style="padding:8px 16px;background:#17a2b8;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px;">测试连接</button>' +
						'<span id="toa-test-result" style="margin-left:12px;font-size:13px;"></span></div>' +
					'<div style="margin-bottom:16px;padding:12px;background:#f8f9fa;border-radius:4px;border:1px solid #e9ecef;">' +
						'<div id="toa-cache-stats" style="font-size:13px;color:#495057;margin-bottom:8px;">已缓存翻译：0 条</div>' +
						'<button id="toa-export" style="padding:6px 12px;background:#6c757d;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;margin-right:8px;">导出缓存到文件</button>' +
						'<button id="toa-import" style="padding:6px 12px;background:#6c757d;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;margin-right:8px;">从文件导入缓存</button>' +
						'<button id="toa-clear" style="padding:6px 12px;background:#dc3545;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;">清空缓存</button>' +
					'<div id="toa-cache-result" style="font-size:12px;color:#666;margin-top:8px;"></div>' +
				'</div>' +
				'</div>' +  <!-- toa-config-area 结束 -->
				'<div style="text-align:right;">' +
					'<button id="toa-cancel" style="padding:8px 16px;background:#ccc;color:#333;border:none;border-radius:4px;cursor:pointer;font-size:14px;margin-right:8px;">取消</button>' +
					'<button id="toa-save" style="padding:8px 16px;background:#28a745;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px;">保存</button>' +
				'</div>' +
			'</div>';
				document.body.appendChild(modal);
				this.modal = modal;

				// 总开关联动：切换时禁用/启用下方配置区
				var enabledCheckbox = modal.querySelector('#toa-enabled');
				var configArea = modal.querySelector('#toa-config-area');
				function updateConfigAreaStyle(){
					if(enabledCheckbox.checked){
						configArea.style.opacity = '1';
						configArea.style.pointerEvents = 'auto';
					}else{
						configArea.style.opacity = '0.4';
						configArea.style.pointerEvents = 'none';
					}
				}
				enabledCheckbox.addEventListener('change', updateConfigAreaStyle);
				updateConfigAreaStyle(); // 初始化

				// 高级区折叠
				var advToggle = modal.querySelector('#toa-adv-toggle');
				var promptArea = modal.querySelector('#toa-prompt');
				advToggle.addEventListener('click', function(){
					if(promptArea.style.display === 'none'){
						promptArea.style.display = 'block';
						advToggle.textContent = '▼ 高级：自定义提示词';
					}else{
						promptArea.style.display = 'none';
						advToggle.textContent = '▶ 高级：自定义提示词';
					}
				});

				// 测试按钮
				modal.querySelector('#toa-test').addEventListener('click', function(){
					self.testConnection();
				});
				// 缓存按钮
				modal.querySelector('#toa-export').addEventListener('click', function(){
					self.exportCache();
				});
				modal.querySelector('#toa-import').addEventListener('click', function(){
					self.importCache();
				});
				modal.querySelector('#toa-clear').addEventListener('click', function(){
					self.clearCache();
				});
				// 取消
				modal.querySelector('#toa-cancel').addEventListener('click', function(){ self.hide(); });
				// 保存
				modal.querySelector('#toa-save').addEventListener('click', function(){ self.saveAndApply(); });
				// 点遮罩关闭
				modal.addEventListener('click', function(e){ if(e.target === modal) self.hide(); });
			},

			// ===== 导出缓存 =====
			exportCache: function(){
				var resultEl = document.getElementById('toa-cache-result');
				if(resultEl){ resultEl.textContent = '导出中...'; resultEl.style.color = '#666'; }
				translate.service.openai.cache.exportToFile(function(ok, msg){
					if(resultEl){
						resultEl.textContent = ok ? '✅ 已导出：' + msg : '❌ 导出失败：' + msg;
						resultEl.style.color = ok ? '#28a745' : '#dc3545';
					}
				});
			},

			// ===== 导入缓存 =====
			importCache: function(){
				var resultEl = document.getElementById('toa-cache-result');
				if(resultEl){ resultEl.textContent = '导入中...'; resultEl.style.color = '#666'; }
				var self = this;
				translate.service.openai.cache.importFromFile(function(ok, msg){
					if(resultEl){
						resultEl.textContent = ok ? '✅ ' + msg : '❌ 导入失败：' + msg;
						resultEl.style.color = ok ? '#28a745' : '#dc3545';
					}
					if(ok) self.refreshCacheStats();
				});
			},

			// ===== 清空缓存（二次确认）=====
			clearCache: function(){
				var resultEl = document.getElementById('toa-cache-result');
				var to = translate.service.openai.cache.currentTo || '当前';
				if(!confirm('确定要清空 ' + to + ' 的翻译缓存吗？\n\n清空后所有已翻译内容将丢失，下次需要重新调用 API 翻译。\n此操作不可恢复！')){
					if(resultEl){ resultEl.textContent = '已取消清空'; resultEl.style.color = '#666'; }
					return;
				}
				var ok = translate.service.openai.cache.clear();
				if(resultEl){
					resultEl.textContent = ok ? '✅ 已清空缓存' : '❌ 清空失败';
					resultEl.style.color = ok ? '#28a745' : '#dc3545';
				}
				this.refreshCacheStats();
			},

			load: function(){
				try{
					var raw = localStorage.getItem('translate_openai_config');
					if(raw){
						var cfg = JSON.parse(raw);
						return cfg;
					}
				}catch(e){ console.warn('[translate.openai] 读取配置失败', e); }
				return null;
			},

		loadIntoForm: function(){
			var cfg = this.load();
			if(!cfg) cfg = {};
			var m = this.modal;
			if(m.querySelector('#toa-enabled')) m.querySelector('#toa-enabled').checked = (cfg.enabled !== false);
			if(m.querySelector('#toa-endpoint')) m.querySelector('#toa-endpoint').value = cfg.endpoint || '';
			if(m.querySelector('#toa-apikey')) m.querySelector('#toa-apikey').value = cfg.apiKey || '';
			if(m.querySelector('#toa-model')) m.querySelector('#toa-model').value = cfg.model || 'deepseek-chat';
			if(m.querySelector('#toa-batchsize')) m.querySelector('#toa-batchsize').value = cfg.batchSize || 10;
			if(m.querySelector('#toa-batchcharlimit')) m.querySelector('#toa-batchcharlimit').value = cfg.batchCharLimit || 1000;
			if(m.querySelector('#toa-concurrency')) m.querySelector('#toa-concurrency').value = cfg.maxConcurrency || 5;
			if(m.querySelector('#toa-output-format')) m.querySelector('#toa-output-format').value = cfg.outputFormat || 'json';
			if(m.querySelector('#toa-progressive')) m.querySelector('#toa-progressive').checked = (cfg.progressiveOutput === true);
			if(m.querySelector('#toa-scene')) m.querySelector('#toa-scene').value = cfg.scene || '游戏文本翻译';
			if(m.querySelector('#toa-temperature')) m.querySelector('#toa-temperature').value = cfg.temperature !== undefined ? cfg.temperature : 0.6;
			if(m.querySelector('#toa-context-enabled')) m.querySelector('#toa-context-enabled').checked = (cfg.contextEnabled !== false);
			if(m.querySelector('#toa-context-limit')) m.querySelector('#toa-context-limit').value = cfg.contextLimit !== undefined ? cfg.contextLimit : 300;
			if(m.querySelector('#toa-context-window')) m.querySelector('#toa-context-window').value = cfg.contextWindow !== undefined ? cfg.contextWindow : 5;
			if(m.querySelector('#toa-prompt')) m.querySelector('#toa-prompt').value = cfg.promptTemplate || translate.service.openai.config.promptTemplate;
			// 触发总开关样式更新
			var enabledCb = m.querySelector('#toa-enabled');
			var configArea = m.querySelector('#toa-config-area');
			if(enabledCb && configArea){
				configArea.style.opacity = enabledCb.checked ? '1' : '0.4';
				configArea.style.pointerEvents = enabledCb.checked ? 'auto' : 'none';
			}
		},

saveAndApply: function(){
			var m = this.modal;
			var enabled = m.querySelector('#toa-enabled') ? m.querySelector('#toa-enabled').checked : true;
			var cfg = {
				enabled: enabled,
				endpoint: m.querySelector('#toa-endpoint').value.trim(),
				apiKey: m.querySelector('#toa-apikey').value.trim(),
				model: m.querySelector('#toa-model').value.trim() || 'deepseek-chat',
				batchSize: parseInt(m.querySelector('#toa-batchsize').value,10) || 10,
				batchCharLimit: parseInt(m.querySelector('#toa-batchcharlimit').value,10) || 1000,
				maxConcurrency: parseInt(m.querySelector('#toa-concurrency').value,10) || 5,
				outputFormat: m.querySelector('#toa-output-format') ? m.querySelector('#toa-output-format').value : 'json',
				progressiveOutput: m.querySelector('#toa-progressive') ? m.querySelector('#toa-progressive').checked : false,
				scene: m.querySelector('#toa-scene').value.trim() || '游戏文本翻译',
				temperature: parseFloat(m.querySelector('#toa-temperature').value) || 0.6,
				contextEnabled: m.querySelector('#toa-context-enabled') ? m.querySelector('#toa-context-enabled').checked : true,
				contextLimit: m.querySelector('#toa-context-limit') ? parseInt(m.querySelector('#toa-context-limit').value,10) : 300,
				contextWindow: m.querySelector('#toa-context-window') ? parseInt(m.querySelector('#toa-context-window').value,10) : 5,
				promptTemplate: m.querySelector('#toa-prompt').value.trim() || translate.service.openai.config.promptTemplate
			};
				try{
					localStorage.setItem('translate_openai_config', JSON.stringify(cfg));
				}catch(e){ console.error('[translate.openai] 保存配置失败', e); }
				// 根据总开关决定走大模型还是 Edge
				if(enabled){
					translate.service.openai.use(cfg);
					if(translate.service.openai.state.mode === 'degraded'){
						console.log('[translate.openai] 配置已更新，立即尝试恢复');
						translate.service.openai._tryRecover(0);
					}
				}else{
					// 关闭大模型，切到 Edge
					translate.service.openai.use(cfg); // 仍然加载配置和缓存（缓存对 Edge 也有用）
					translate.service.openai.disable();
				}
				this.hide();
				console.log('[translate.openai] 配置已保存并应用（大模型' + (enabled ? '开启' : '关闭') + '）');
			},

			testConnection: function(){
				var m = this.modal;
				var cfg = {
					endpoint: m.querySelector('#toa-endpoint').value.trim(),
					apiKey: m.querySelector('#toa-apikey').value.trim(),
					model: m.querySelector('#toa-model').value.trim() || 'deepseek-chat',
					scene: m.querySelector('#toa-scene').value.trim() || '游戏文本翻译'
				};
				var resultEl = m.querySelector('#toa-test-result');
				if(!cfg.endpoint || !cfg.apiKey){
					resultEl.textContent = '请填写端点和 API Key';
					resultEl.style.color = '#dc3545';
					return;
				}
				resultEl.textContent = '测试中...';
				resultEl.style.color = '#666';
				var self = this;
			var prompt = (cfg.promptTemplate || translate.service.openai.config.promptTemplate)
				.replace(/\{scene\}/g, cfg.scene)
				.replace(/\{from\}/g, 'English')
				.replace(/\{to\}/g, '简体中文')
				.replace(/\{sep\}/g, translate.service.openai.config.separator)
				.replace(/\{context\}/g, '')
				.replace(/\{outputFormat\}/g, translate.service.openai._buildOutputFormatInstruction(false))
				.replace(/\{content\}/g, 'Hello');
				// 临时用填入的配置发请求
				var origEndpoint = translate.service.openai.config.endpoint;
				var origKey = translate.service.openai.config.apiKey;
				var origModel = translate.service.openai.config.model;
				translate.service.openai.config.endpoint = cfg.endpoint;
				translate.service.openai.config.apiKey = cfg.apiKey;
				translate.service.openai.config.model = cfg.model;
				var startedAt = Date.now();
				translate.service.openai._callOpenAI(prompt).then(function(reply){
					var elapsed = Date.now() - startedAt;
					resultEl.textContent = '✅ 成功（' + elapsed + 'ms）：' + reply.trim().substring(0,30);
					resultEl.style.color = '#28a745';
				}).catch(function(err){
					resultEl.textContent = '❌ 失败：' + (err.message || err);
					resultEl.style.color = '#dc3545';
				}).then(function(){
					// 恢复原配置（未保存前不真正应用）
					translate.service.openai.config.endpoint = origEndpoint;
					translate.service.openai.config.apiKey = origKey;
					translate.service.openai.config.model = origModel;
				});
			}
		},

		// ===== 状态徽章（含进度条）=====
		statusBadge: {
			el: null,
			translating: false,       // 是否正在翻译
			completedTimer: null,     // "翻译完成"提示的淡出计时器
			build: function(){
				if(this.el) return;
				var el = document.createElement('div');
				el.id = 'translate-openai-badge';
				el.setAttribute('class','ignore translate-openai-badge');
				el.style.cssText = 'position:fixed;right:106px;bottom:20px;display:flex;align-items:center;gap:8px;background:rgba(0,0,0,0.6);color:#fff;padding:6px 12px;border-radius:18px;z-index:2147483647;font-size:12px;font-family:sans-serif;cursor:pointer;user-select:none;transition:all 0.3s ease;';
				el.innerHTML =
					'<span class="dot" style="width:8px;height:8px;border-radius:50%;background:#28a745;display:inline-block;flex-shrink:0;"></span>' +
					'<span class="label" style="white-space:nowrap;">大模型翻译中</span>' +
					'<span class="progress-wrap" style="display:none;align-items:center;gap:6px;">' +
						'<span class="progress-bar" style="width:80px;height:6px;background:rgba(255,255,255,0.2);border-radius:3px;overflow:hidden;flex-shrink:0;">' +
							'<span class="progress-fill" style="display:block;height:100%;width:0%;background:#28a745;border-radius:3px;transition:width 0.3s ease;"></span>' +
						'</span>' +
						'<span class="progress-text" style="font-size:11px;white-space:nowrap;opacity:0.85;">0/0</span>' +
					'</span>';
				var self = this;
				el.addEventListener('click', function(){ translate.service.openai.settingsUI.show(); });
				document.body.appendChild(el);
				this.el = el;
			},

			setMode: function(mode){
				if(!this.el) return;
				var dot = this.el.querySelector('.dot');
				var label = this.el.querySelector('.label');
				var fill = this.el.querySelector('.progress-fill');
				if(mode === 'openai'){
					dot.style.background = '#28a745';
					dot.style.animation = '';
					label.textContent = '大模型翻译中';
					label.style.color = '#fff';
					if(fill) fill.style.background = '#28a745';
					this.el.title = '当前使用 OpenAI 兼容大模型翻译';
				}else if(mode === 'degraded'){
					dot.style.background = '#dc3545';
					dot.style.animation = 'translate-openai-blink 1.5s infinite';
					label.textContent = '已降级·质量下降';
					label.style.color = '#ffb3b3';
					if(fill) fill.style.background = '#dc3545';
					var reason = translate.service.openai.state.degradeReason || '未知原因';
					var t = translate.service.openai.state.lastDegradedAt ? new Date(translate.service.openai.state.lastDegradedAt).toLocaleTimeString() : '';
					this.el.title = '已降级到 Edge 浏览器翻译，质量下降\n原因：' + reason + '\n时间：' + t + '\n将自动探测恢复';
				}else if(mode === 'disabled'){
					dot.style.background = '#999';
					dot.style.animation = '';
					label.textContent = '已关闭·Edge翻译';
					label.style.color = '#ccc';
					if(fill) fill.style.background = '#999';
					this.el.title = '大模型翻译已关闭，当前使用 Edge 浏览器原生翻译\n点击打开设置可重新开启';
				}
			},

			// ===== 设置翻译中状态（显示/隐藏进度条区域）=====
			setTranslating: function(isTranslating){
				this.translating = isTranslating;
				if(!this.el) return;
				var progressWrap = this.el.querySelector('.progress-wrap');
				if(!progressWrap) return;
				if(isTranslating){
					progressWrap.style.display = 'flex';
					// 清除"翻译完成"提示
					if(this.completedTimer){ clearTimeout(this.completedTimer); this.completedTimer = null; }
					var label = this.el.querySelector('.label');
					if(label){
						var mode = translate.service.openai.state.mode;
						if(mode === 'degraded') label.textContent = '翻译中...';
						else if(mode === 'disabled') label.textContent = '翻译中...';
						else label.textContent = '翻译中...';
					}
				}else{
					progressWrap.style.display = 'none';
					// 进度条归零
					this.updateProgress(0, 0);
					// 恢复 label 为常态
					var label2 = this.el.querySelector('.label');
					if(label2){
						var mode2 = translate.service.openai.state.mode;
						if(mode2 === 'degraded') label2.textContent = '已降级·质量下降';
						else if(mode2 === 'disabled') label2.textContent = '已关闭·Edge翻译';
						else label2.textContent = '大模型翻译中';
					}
				}
			},

			// ===== 更新进度条 =====
			updateProgress: function(done, total){
				if(!this.el) return;
				var fill = this.el.querySelector('.progress-fill');
				var text = this.el.querySelector('.progress-text');
				if(!fill || !text) return;
				var pct = total > 0 ? Math.round((done / total) * 100) : 0;
				fill.style.width = pct + '%';
				text.textContent = done + '/' + total;
			},

			// ===== 显示"翻译完成"提示（3 秒后淡出）=====
			showCompleted: function(){
				if(!this.el) return;
				if(this.completedTimer){ clearTimeout(this.completedTimer); this.completedTimer = null; }
				var label = this.el.querySelector('.label');
				var dot = this.el.querySelector('.dot');
				if(!label || !dot) return;
				var prevText = label.textContent;
				var prevColor = dot.style.background;
				label.textContent = '✅ 翻译完成';
				label.style.color = '#90ee90';
				dot.style.background = '#90ee90';
				var self = this;
				this.completedTimer = setTimeout(function(){
					// 恢复常态
					var mode = translate.service.openai.state.mode;
					self.setMode(mode);
					self.completedTimer = null;
				}, 3000);
			}
		},

		// ===== 本地持久化缓存模块 =====
		cache: {
			dir: '',                // TranslateCache 目录绝对路径
			initialized: false,
			dirty: false,
			writeTimer: null,
			debounceMs: 3000,       // 防抖写入间隔
			currentTo: '',          // 当前加载的语种
			memory: {},             // 当前 to 的 entries 内存镜像 { hash: translated }
			_fs: null,
			_path: null,
			_dialog: null,
			_electronRemote: null,

			// ===== 初始化：确定目录、获取 fs/path/dialog =====
			init: function(){
				if(this.initialized) return;
				try{
					if(typeof require === 'function'){
						this._fs = require('fs');
						this._path = require('path');
						// 确定 userData 目录
						var userData = null;
						try{
							var remote = null;
							try{ remote = require('@electron/remote'); }catch(e){}
							if(!remote){ try{ remote = require('electron').remote; }catch(e){} }
							if(remote && remote.app && remote.app.getPath){
								userData = remote.app.getPath('userData');
								this._electronRemote = remote;
							}
						}catch(e){}
						// 兜底：Windows %APPDATA%/{appName}
						if(!userData && process.env.APPDATA){
							userData = this._path.join(process.env.APPDATA, 'TiTS');
						}
						if(userData){
							this.dir = this._path.join(userData, 'TranslateCache');
							if(!this._fs.existsSync(this.dir)){
								this._fs.mkdirSync(this.dir, {recursive:true});
							}
							// 获取 dialog
							if(this._electronRemote && this._electronRemote.dialog){
								this._dialog = this._electronRemote.dialog;
							}
							this.initialized = true;
							console.log('[translate.openai] 缓存目录：' + this.dir);
							return;
						}
					}
				}catch(e){
					console.warn('[translate.openai] 缓存初始化失败，将仅用 localStorage', e);
				}
				// Node 不可用，仅用 localStorage 模式
				this.initialized = true;
				console.log('[translate.openai] Node fs 不可用，缓存仅存 localStorage');
			},

			// ===== 文件路径
			_filePath: function(to){
				if(!this._path || !this.dir) return null;
				return this._path.join(this.dir, to + '.json');
			},

			// ===== 加载指定语种缓存 → 灌入 localStorage + memory =====
			loadFor: function(to){
				if(!to) return;
				this.currentTo = to;
				this.memory = {};
				this.dirty = false;
				if(this.writeTimer){ clearTimeout(this.writeTimer); this.writeTimer = null; }
				if(!this._fs) return;
				var fp = this._filePath(to);
				if(!fp || !this._fs.existsSync(fp)){
					console.log('[translate.openai] 缓存文件不存在：' + (fp || to) + '，从空开始');
					return;
				}
				try{
					var raw = this._fs.readFileSync(fp, {encoding:'utf8'});
					var data = JSON.parse(raw);
					if(data && data.entries){
						var count = 0;
						for(var h in data.entries){
							if(data.entries.hasOwnProperty(h)){
								this.memory[h] = data.entries[h];
								// 灌入 localStorage，让 translate.js 命中
								try{ translate.storage.set('hash_' + to + '_' + h, data.entries[h]); }catch(e){}
								count++;
							}
						}
						console.log('[translate.openai] 已加载缓存：' + to + '，共 ' + count + ' 条');
					}
				}catch(e){
					console.warn('[translate.openai] 缓存文件解析失败：' + fp + '，备份后从空开始', e);
					// 备份损坏的文件
					try{
						var bak = fp + '.bak.' + Date.now();
						this._fs.copyFileSync(fp, bak);
						console.log('[translate.openai] 已备份损坏文件至 ' + bak);
					}catch(e2){}
				}
			},

					// ===== 加载所有语种缓存文件（重启时调用，确保所有缓存都灌入 localStorage）=====
			loadAll: function(){
				if(!this._fs || !this.dir) return;
				try{
					var files = this._fs.readdirSync(this.dir);
					var loaded = 0;
					for(var i=0; i<files.length; i++){
						var f = files[i];
						// 只处理 *.json，跳过 .tmp .bak 等
						if(!f.endsWith('.json')) continue;
						// 文件名就是语种名
						var to = f.replace(/\.json$/,'');
						// currentTo 已在 loadFor 里加载过，跳过避免重复
						if(to === this.currentTo && Object.keys(this.memory).length > 0) continue;
						var fp = this._path.join(this.dir, f);
						try{
							var raw = this._fs.readFileSync(fp, {encoding:'utf8'});
							var data = JSON.parse(raw);
							if(data && data.entries){
								var count = 0;
								for(var h in data.entries){
									if(data.entries.hasOwnProperty(h)){
										try{ translate.storage.set('hash_' + to + '_' + h, data.entries[h]); }catch(e){}
										count++;
									}
								}
								loaded++;
								console.log('[translate.openai] loadAll: 已加载 ' + to + ' 缓存 ' + count + ' 条');
							}
						}catch(e){
							console.warn('[translate.openai] loadAll: 解析 ' + f + ' 失败', e);
						}
					}
					if(loaded > 0){
						console.log('[translate.openai] loadAll: 共加载 ' + loaded + ' 个语种缓存文件');
					}else{
						console.log('[translate.openai] loadAll: 无缓存文件可加载');
					}
				}catch(e){
					console.warn('[translate.openai] loadAll: 读取缓存目录失败', e);
				}
			},

			// ===== 记录一条新翻译 =====
			record: function(hash, translated, to){
				if(!to || to !== this.currentTo){
					// 语种不匹配，切换 memory
					this.currentTo = to;
					this.memory = {};
				}
				this.memory[hash] = translated;
				this.dirty = true;
				this.scheduleFlush();
			},

			// ===== 防抖调度写入 =====
			scheduleFlush: function(){
				if(!this._fs) return;
				if(this.writeTimer) clearTimeout(this.writeTimer);
				var self = this;
				this.writeTimer = setTimeout(function(){
					self.flush();
				}, this.debounceMs);
			},

			// ===== 异步写入文件 =====
			flush: function(){
				if(!this._fs || !this.dirty || !this.currentTo) return;
				this.writeTimer = null;
				this.dirty = false;
				var fp = this._filePath(this.currentTo);
				if(!fp) return;
				var data = {
					version: 1,
					to: this.currentTo,
					updatedAt: Date.now(),
					count: Object.keys(this.memory).length,
					entries: this.memory
				};
				var jsonStr = JSON.stringify(data);
				// 原子写：先写 .tmp 再 rename
				var tmp = fp + '.tmp';
				var self = this;
				this._fs.writeFile(tmp, jsonStr, {encoding:'utf8'}, function(err){
					if(err){
						console.warn('[translate.openai] 缓存写入失败', err);
						self.dirty = true; // 失败了重新标记 dirty，下次再写
						return;
					}
					self._fs.rename(tmp, fp, function(err2){
						if(err2){
							console.warn('[translate.openai] 缓存 rename 失败', err2);
							// tmp 已写但 rename 失败，尝试直接复制
							try{ self._fs.copyFileSync(tmp, fp); }catch(e){}
						}
					});
				});
			},

			// ===== 同步写入（关窗时用，避免进程退出写一半）=====
			flushSync: function(){
				if(!this._fs || !this.dirty || !this.currentTo) return;
				if(this.writeTimer){ clearTimeout(this.writeTimer); this.writeTimer = null; }
				this.dirty = false;
				var fp = this._filePath(this.currentTo);
				if(!fp) return;
				try{
					var data = {
						version: 1,
						to: this.currentTo,
						updatedAt: Date.now(),
						count: Object.keys(this.memory).length,
						entries: this.memory
					};
					var tmp = fp + '.tmp';
					this._fs.writeFileSync(tmp, JSON.stringify(data), {encoding:'utf8'});
					this._fs.renameSync(tmp, fp);
					console.log('[translate.openai] 关窗强制写入缓存完成：' + Object.keys(this.memory).length + ' 条');
				}catch(e){
					console.warn('[translate.openai] 关窗写入缓存失败', e);
				}
			},

			// ===== 统计：条数 =====
			count: function(){
				return Object.keys(this.memory).length;
			},

			// ===== 统计：文件大小（字节）=====
			size: function(){
				if(!this._fs || !this.currentTo) return 0;
				var fp = this._filePath(this.currentTo);
				if(!fp || !this._fs.existsSync(fp)) return 0;
				try{
					var stat = this._fs.statSync(fp);
					return stat.size;
				}catch(e){ return 0; }
			},

			// ===== 清空当前语种缓存 =====
			clear: function(){
				var to = this.currentTo;
				if(!to) return false;
				// 清 memory
				this.memory = {};
				this.dirty = false;
				if(this.writeTimer){ clearTimeout(this.writeTimer); this.writeTimer = null; }
				// 删文件
				if(this._fs){
					var fp = this._filePath(to);
					if(fp && this._fs.existsSync(fp)){
						try{ this._fs.unlinkSync(fp); }catch(e){}
					}
				}
				// 清 localStorage 中 hash_{to}_*
				try{
					var keys = [];
					for(var i=0; i<localStorage.length; i++){
						var k = localStorage.key(i);
						if(k && k.indexOf('hash_' + to + '_') === 0) keys.push(k);
					}
					keys.forEach(function(k){ localStorage.removeItem(k); });
				}catch(e){}
				console.log('[translate.openai] 已清空 ' + to + ' 缓存');
				return true;
			},

			// ===== 导出缓存到用户选择的文件 =====
			exportToFile: function(onDone){
				if(!this._fs || !this._dialog){
					// 降级：用 Blob 下载
					this._exportViaBlob(onDone);
					return;
				}
				var to = this.currentTo || 'cache';
				var defaultName = to + '_cache_' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '.json';
				var self = this;
				this._dialog.showSaveDialog({
					defaultPath: defaultName,
					filters: [{name:'JSON', extensions:['json']}]
				}).then(function(result){
					if(result.canceled || !result.filePath){
						if(onDone) onDone(false, '已取消');
						return;
					}
					try{
						var data = {
							version: 1,
							to: self.currentTo,
							exportedAt: Date.now(),
							count: Object.keys(self.memory).length,
							entries: self.memory
						};
						self._fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), {encoding:'utf8'});
						console.log('[translate.openai] 已导出缓存到 ' + result.filePath);
						if(onDone) onDone(true, result.filePath);
					}catch(e){
						console.error('[translate.openai] 导出失败', e);
						if(onDone) onDone(false, e.message);
					}
				}).catch(function(e){
					if(onDone) onDone(false, e.message);
				});
			},

			// ===== Blob 降级导出（无 dialog 时）=====
			_exportViaBlob: function(onDone){
				try{
					var data = {
						version: 1,
						to: this.currentTo,
						exportedAt: Date.now(),
						count: Object.keys(this.memory).length,
						entries: this.memory
					};
					var blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
					var url = URL.createObjectURL(blob);
					var a = document.createElement('a');
					a.href = url;
					a.download = (this.currentTo || 'cache') + '_cache.json';
					a.click();
					URL.revokeObjectURL(url);
					if(onDone) onDone(true, '浏览器下载');
				}catch(e){
					if(onDone) onDone(false, e.message);
				}
			},

			// ===== 从用户选择的文件导入缓存 =====
			importFromFile: function(onDone){
				if(!this._fs || !this._dialog){
					// 降级：用 <input type=file>
					this._importViaInput(onDone);
					return;
				}
				var self = this;
				this._dialog.showOpenDialog({
					properties: ['openFile'],
					filters: [{name:'JSON', extensions:['json']}]
				}).then(function(result){
					if(result.canceled || !result.filePaths || result.filePaths.length === 0){
						if(onDone) onDone(false, '已取消');
						return;
					}
					var fp = result.filePaths[0];
					try{
						var raw = self._fs.readFileSync(fp, {encoding:'utf8'});
						var data = JSON.parse(raw);
						if(!data || !data.entries){
							if(onDone) onDone(false, '文件格式不正确（缺少 entries 字段）');
							return;
						}
						var to = data.to || self.currentTo;
						// 如果导入的语种跟当前不同，先切到那个语种的 memory
						if(to !== self.currentTo){
							self.loadFor(to);
						}
						var added = 0;
						for(var h in data.entries){
							if(data.entries.hasOwnProperty(h)){
								self.memory[h] = data.entries[h];
								try{ translate.storage.set('hash_' + to + '_' + h, data.entries[h]); }catch(e){}
								added++;
							}
						}
						self.dirty = true;
						self.flush(); // 立即写入
						console.log('[translate.openai] 已从 ' + fp + ' 导入 ' + added + ' 条缓存（语种：' + to + '）');
						if(onDone) onDone(true, '导入 ' + added + ' 条');
					}catch(e){
						console.error('[translate.openai] 导入失败', e);
						if(onDone) onDone(false, e.message);
					}
				}).catch(function(e){
					if(onDone) onDone(false, e.message);
				});
			},

			// ===== <input type=file> 降级导入 =====
			_importViaInput: function(onDone){
				var self = this;
				var input = document.createElement('input');
				input.type = 'file';
				input.accept = '.json,application/json';
				input.style.display = 'none';
				input.addEventListener('change', function(e){
					var file = e.target.files[0];
					if(!file){ if(onDone) onDone(false, '已取消'); return; }
					var reader = new FileReader();
					reader.onload = function(ev){
						try{
							var data = JSON.parse(ev.target.result);
							if(!data || !data.entries){
								if(onDone) onDone(false, '文件格式不正确');
								return;
							}
							var to = data.to || self.currentTo;
							if(to !== self.currentTo){ self.loadFor(to); }
							var added = 0;
							for(var h in data.entries){
								if(data.entries.hasOwnProperty(h)){
									self.memory[h] = data.entries[h];
									try{ translate.storage.set('hash_' + to + '_' + h, data.entries[h]); }catch(e){}
									added++;
								}
							}
							self.dirty = true;
							self.flush();
							if(onDone) onDone(true, '导入 ' + added + ' 条');
						}catch(err){
							if(onDone) onDone(false, err.message);
						}
					};
					reader.readAsText(file);
				});
				document.body.appendChild(input);
				input.click();
				setTimeout(function(){ document.body.removeChild(input); }, 5000);
			}
		}
	};

	// ===== 注入徽章闪烁动画 CSS（一次性）=====
	try{
		var style = document.createElement('style');
		style.setAttribute('class','ignore');
		style.textContent = '@keyframes translate-openai-blink{0%,100%{opacity:1}50%{opacity:0.3}}';
		document.head.appendChild(style);
	}catch(e){}

	console.log('[translate.openai] 插件已加载，版本 1.0，等待激活');
})();
