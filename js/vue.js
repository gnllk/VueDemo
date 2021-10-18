class Vue{
    constructor(options){
        this.$ele = options.el;
        this.$data = options.data;
        this.$methods = options.methods;
        this.$computed = options.computed;
        if(this.$ele){
            this.$publisher = new Publisher(this);
            this.createObjectProxy(options.data);
            this.createObjectProxy(options.methods);
            this.createObjectGetterProxy(options.computed);
            new Compiler(this.$ele, this);
            if(options.created && typeof(options.created) == 'function'){
                options.created.call(this);
            }
        }
    }
    createObjectProxy(obj){
        if(obj){
            for(let key in obj){
                Object.defineProperty(this, key, {
                    get:()=>{
                        return obj[key];
                    },
                    set:(newVal)=>{
                        obj[key] = newVal;
                    }
                });
            }
        }
    }
    createObjectGetterProxy(obj){
        if(obj){
            for(let key in obj){
                Object.defineProperty(this, key, {
                    get:()=>{
                        return obj[key];
                    }
                });
            }
        }
    }
}

class Compiler{
    constructor(ele, vue){
        this.$ele = this.isElement(ele) ? ele : document.querySelector(ele);
        this.$vue = vue;
        let fragment = this.nodeToFragment(this.$ele);
        this.compile(fragment, this.$vue.$data);
        this.$ele.appendChild(fragment);
    }
    isElement(node){
        return node.nodeType === 1;
    }
    isDirective(str){
        return str.startsWith("v-");
    }
    isTextExpr(str){
        return /\{\s*\{.+?\}\s*\}/gm.test(str);
    }
    nodeToFragment(node){
        let fragment = document.createDocumentFragment();
        let childNode;
        while(childNode = node.firstChild){
            fragment.appendChild(childNode);
        }
        return fragment;
    }
    compile(node){
        node.childNodes.forEach(child=>{
            if(this.isElement(child)){
                this.compileElement(child);
                this.compile(child);
            } else {
                this.compileText(child);
            }
        });
    }
    compileElement(node){
        let attrs = node.attributes;
        [...attrs].forEach(attr=>{
            let {name, value} = attr;
            if(this.isDirective(name)){
                let [,directiveText] = name.split('-');
                let [directive,content] = directiveText.split(':');
                CompileUtils.update[directive](this.$vue, node, value, content);
            }
        });
    }
    compileText(node){ 
        let textExpr = node.textContent;
        if(this.isTextExpr(textExpr)){
            CompileUtils.update['text'](this.$vue, node, textExpr);
        }
    }
}

CompileUtils = {
    getExprValue: function(expr, data){
        // get expr "user.name" value from data
        return expr.split('.').reduce((prev, curr, i)=>{ 
            return prev ? prev[curr] : null; 
        }, data);
    },
    setExprValue: function(expr, data, value){
        // set data property via expr
        expr.split('.').reduce((prev, curr, i, arr)=>{
            if(prev && i == arr.length - 1){
                prev[curr] = value;
            }
            return prev ? prev[curr] : null; 
        }, data);
    },
    getComputedValue(expr, vue){
        // get the computed value by expr
        let fn = this.getExprValue(expr, vue.$computed);
        return fn && typeof(fn) == 'function' ? fn.call(vue) : null;
    },
    getExpr: function(exprWithBrace){
        // will return user.name from {{user.name}}
        return /\{\s*\{(.+?)\}\s*\}/.exec(exprWithBrace)[1];
    },
    compileTextExpr: function(textExpr, getExprValFn){
        // compile text expr like "Name: {{user.name}}, Age: {{user.age}}"
        return textExpr.replace(/\{\s*\{(.+?)\}\s*\}/gm, match=>{
            return getExprValFn(this.getExpr(match));
        });
    },
    update:{
        // {{user.name}}
        text:function(vue, node, textExpr){
            // update text expr {{user.name}} with expr value
            node.textContent = CompileUtils.compileTextExpr(textExpr, expr1=>{
                let computedVal = CompileUtils.getComputedValue(expr1, vue);
                if(computedVal){
                    // new subscriber to watch all(*) property changed event, 
                    // because it is a computed value
                    let sub = new Subscriber('*', newVal=>{
                        node.textContent = CompileUtils.compileTextExpr(textExpr, expr2=>{
                            return CompileUtils.getComputedValue(expr2, vue);
                        });
                    });
                    vue.$publisher.addSub(sub);
                    return computedVal;
                }else{
                    // new subscriber to watch property expr1 user.name changed event
                    let sub = new Subscriber(expr1, newVal=>{
                        node.textContent = CompileUtils.compileTextExpr(textExpr, expr2=>{
                            return CompileUtils.getExprValue(expr2, vue);
                        });
                    });
                    vue.$publisher.addSub(sub);
                    return CompileUtils.getExprValue(expr1, vue);
                }
            });
        },
        // v-html
        html:function(vue, node, expr){
            let textExpr = '{{' + expr + '}}';
            // update text expr {{user.name}} with expr value
            node.innerHTML = CompileUtils.compileTextExpr(textExpr, expr1=>{
                // new subscriber to watch property changed event
                let sub = new Subscriber(expr1, newVal=>{
                    node.innerHTML = CompileUtils.compileTextExpr(textExpr, expr2=>{
                        return CompileUtils.getExprValue(expr2, vue);
                    });
                });
                vue.$publisher.addSub(sub);
                return CompileUtils.getExprValue(expr1, vue);
            });
        },
        // v-model
        model: function(vue, node, expr){
            // new subscriber to watch property changed event
            let sub = new Subscriber(expr, newVal=>{
                node.value = newVal;
            });
            vue.$publisher.addSub(sub);
            // update input value with expr value
            node.value = CompileUtils.getExprValue(expr, vue.$data);
            // listen input event changed
            node.addEventListener('input', ()=>{
                CompileUtils.setExprValue(expr, vue.$data, node.value);
            });
        },
        // v-on:click
        on: function(vue, node, expr, eventName){
            let fn = CompileUtils.getExprValue(expr, vue.$methods);
            node.addEventListener(eventName, e=>{
                if(fn && typeof(fn) == 'function'){
                    fn.call(vue, e);
                }
            });
        },
        // v-bind:title
        bind: function(vue, node, expr, attrName){
            this.__onComputedOrDataChanged(vue, node, expr, newVal=>{
                node.setAttribute(attrName, newVal);
            });
        },
        // v-if
        if: function(vue, node, expr){
            this.__onComputedOrDataChanged(vue, node, expr, newVal=>{
                node.hidden = !newVal;
            });
        },
        // internal watch property changed 
        __onComputedOrDataChanged(vue, node, expr, onChanged){
            let computedVal = CompileUtils.getComputedValue(expr, vue);
            if(computedVal){
                let sub = new Subscriber('*', newVal=>{
                    onChanged(CompileUtils.getComputedValue(expr, vue));
                });
                vue.$publisher.addSub(sub);
                onChanged(computedVal);
            }else{
                let sub = new Subscriber(expr, newVal=>onChanged(newVal));
                vue.$publisher.addSub(sub);
                onChanged(CompileUtils.getExprValue(expr, vue.$data));
            }
        }
    }
}

class Subscriber{
    constructor(topic, onUpdateFn){
        this.$topic = topic;
        this.$onUpdateFn = onUpdateFn;
    }
    getTopic(){
        return this.$topic;
    }
    onUpdate(message){
        this.$onUpdateFn(message);
    }
}

class Publisher{
    constructor(vue){
        this.$vue = vue;
        this.__subs = {};
        new Observer(vue.$data, (topic, newVal)=>{
            for(let key in this.__subs){
                if(this.__isMatch(topic, key)){ 
                    this.__subs[key].forEach(sub=>sub.onUpdate(newVal));
                }
            }
        });
    }
    addSub(subscriber, topic){
        if(!topic){
            topic = subscriber.getTopic();
        }
        if(!topic){
            throw 'Missing topic';
        }
        if(!this.__subs[topic]){
            this.__subs[topic] = [];
        }
        this.__subs[topic].push(subscriber);
    }
    __isMatch(topic, patten){
        if(topic == patten || patten == '*') return true; 
        if(!patten.includes('*')) return false;
        let [startStr, endStr] = patten.split('*');
        if(startStr && endStr){
            return topic.startsWith(startStr) && topic.endsWith(endStr);
        }else if(startStr){
            return topic.startsWith(startStr);
        }else if(endStr){
            topic.endsWith(endStr);
        }
        return false;
    }
}

class Observer{
    constructor(data, onPropertyChangedFn){
        this.$data = data;
        this.$onPropertyChangedFn = onPropertyChangedFn;
        this.observer(data);
    }
    observer(data, parentsKey){
        if(!data || typeof(data) != 'object') return;
        // foreach properties
        for(let key in data){
            let val = data[key];
            let expr = parentsKey ? parentsKey + '.' + key : key;
            // observer sub object
            this.observer(val, expr);
            // define property get and set
            Object.defineProperty(data, key, {
                get:()=>{
                    return val;
                },
                set:(newVal)=>{
                    if(newVal == val) return;
                    val = newVal;
                    this.observer(newVal, expr);
                    this.$onPropertyChangedFn(expr, newVal);
                }
            });
        }
    }
}