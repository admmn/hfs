import {
    AvailablePlugin,
    enablePlugins,
    getAvailablePlugins,
    getPluginConfigFields,
    mapPlugins,
    Plugin, pluginsConfig,
    PATH as PLUGINS_PATH, isPluginRunning, enablePlugin, getPluginInfo
} from './plugins'
import _ from 'lodash'
import assert from 'assert'
import { objSameKeys, onOff, same, wait } from './misc'
import { ApiHandlers, sendList } from './apiMiddleware'
import events from './events'
import { rm } from 'fs/promises'
import { downloadPlugin, getRepo2folder, getRepoInfo, readOnlinePlugin, searchPlugins } from './github'

const apis: ApiHandlers = {

    get_plugins({}, ctx) {
        const list = sendList([ ...mapPlugins(serialize), ...getAvailablePlugins() ])
        return list.events(ctx, {
            pluginInstalled: p => list.add(serialize(p)),
            'pluginStarted pluginStopped pluginUpdated': p => {
                const { id, ...rest } = serialize(p)
                list.update({ id }, rest)
            },
            pluginUninstalled: id => list.remove({ id }),
        })

        function serialize(p: Readonly<Plugin> | AvailablePlugin) {
            return _.defaults('getData' in p ? Object.assign(_.pick(p, ['id','started']), p.getData()) : p,
                { started: null, badApi: null }) // nulls should be used to be sure to overwrite previous values,
        }
    },

    async get_plugin_updates() {
        const list = sendList()
        setTimeout(async () => {
            const repo2folder = getRepo2folder()
            for (const repo in repo2folder)
                try {
                    const online = await readOnlinePlugin(await getRepoInfo(repo))
                    if (!online.apiRequired || online.badApi) continue
                    const disk = getPluginInfo(repo2folder[repo])
                    if (online.version! > disk.version)
                        list.add(online)
                }
                catch (err:any) {
                    list.error(err.code || err.message)
                }
            list.end()
        })
        return list.return
    },

    async set_plugin({ id, enabled, config }) {
        assert(id, 'id')
        if (enabled !== undefined)
            enablePlugin(id, enabled)
        if (config) {
            const fields = getPluginConfigFields(id)
            config = _.pickBy(config, (v, k) =>
                v !== null && !same(v, fields?.[k]?.defaultValue))
            if (_.isEmpty(config))
                config = undefined
            pluginsConfig.set(v => ({ ...v, [id]: config }))
        }
        return {}
    },

    async get_plugin({ id }) {
        return {
            enabled: enablePlugins.get().includes(id),
            config: {
                ...objSameKeys(getPluginConfigFields(id) ||{}, v => v?.defaultValue),
                ...pluginsConfig.get()[id]
            }
        }
    },

    search_online_plugins({ text }, ctx) {
        const list = sendList()
        const repo2folder = getRepo2folder()
        setTimeout(async () => {
            try {
                for await (const pl of searchPlugins(text)) {
                    const repo = pl.id
                    Object.assign(pl, { installed: repo2folder[repo] })
                    list.add(pl)
                    // watch for events about this plugin, until this request is closed
                    ctx.req.on('close', onOff(events, {
                        pluginInstalled: p => {
                            if (p.repo === repo)
                                list.update({ id: repo }, { installed: true })
                        },
                        pluginUninstalled: id => {
                            if (repo === _.findKey(repo2folder, x => x === id))
                                list.update({ id: repo }, { installed: false })
                        },
                        ['pluginDownload_'+repo](status) {
                            list.update({ id: repo }, { downloading: status ?? null })
                        }
                    }) )
                }
            }
            catch (err: any) {
                list.error(err.code || err.message)
            }
            list.end()
        })
        return list.return
    },

    async download_plugin(pl) {
        await downloadPlugin(pl.id, pl.branch)
        return {}
    },

    async update_plugin(pl) {
        await downloadPlugin(pl.id, pl.branch, true)
        return {}
    },

    async uninstall_plugin({ id }) {
        while (isPluginRunning(id)) {
            enablePlugin(id, false)
            await wait(500)
        }
        await rm(PLUGINS_PATH + '/' + id,  { recursive: true, force: true })
        return {}
    }

}

export default apis
